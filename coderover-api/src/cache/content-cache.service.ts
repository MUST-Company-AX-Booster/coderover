import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { CacheEntry } from '../entities/cache-entry.entity';
import { BLOB_STORE, BlobStore, buildBlobPath } from './blob-store';
import { ArtifactKind, ARTIFACT_KINDS } from './types';

/**
 * Phase 10 C1 — Single interface for content-addressed cache reads/writes.
 *
 * All cache consumers (C2 incremental ingest, C3 watch daemon, anywhere
 * else downstream) MUST go through this service. Direct blob-store access
 * skips the Postgres metadata + LRU bookkeeping and leaks invariants.
 *
 * Contract:
 *   - `computeKey(content)` is deterministic: same normalized bytes →
 *     same SHA256 hex. Line endings are normalized to LF; a leading
 *     UTF-8 BOM is stripped. Nothing else.
 *   - `put` is an UPSERT keyed on `(cache_key, artifact_kind)`. Re-put
 *     replaces the blob and refreshes `last_accessed_at`.
 *   - `get` returns the decoded value or null on miss, and bumps
 *     `last_accessed_at` on a hit (LRU touch).
 *   - `invalidate(key)` removes every artifact kind for that key; used
 *     when a file's content hash disappears from the index (deletion).
 *
 * Artifacts are JSON-encoded before hitting the blob store. That loses
 * ~5-10% vs MessagePack but keeps debugging trivial and the cache
 * contents grep-able. C2 can override if it becomes a bottleneck.
 */
@Injectable()
export class ContentCacheService {
  private readonly logger = new Logger(ContentCacheService.name);

  constructor(
    @InjectRepository(CacheEntry)
    private readonly cacheRepo: Repository<CacheEntry>,
    @Inject(BLOB_STORE) private readonly blobStore: BlobStore,
  ) {}

  /**
   * Deterministic content key. Normalizes line endings and strips a
   * leading UTF-8 BOM before hashing, so:
   *   - Windows checkouts hash the same as Unix checkouts
   *   - Editors that write a BOM don't invalidate the cache
   *
   * Anything else (trailing newlines, whitespace, encoding other than
   * UTF-8) is preserved intentionally — those ARE real content changes.
   */
  computeKey(content: string | Buffer): string {
    const buf = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, 'utf8');

    // Strip leading UTF-8 BOM (EF BB BF) if present.
    let body = buf;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      body = buf.subarray(3);
    }

    // Normalize line endings: CRLF → LF, lone CR → LF.
    // Done on bytes to avoid a UTF-8 round-trip when input is already Buffer.
    const normalized = normalizeLineEndings(body);

    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Returns the decoded artifact for (key, kind), or null on miss.
   * A hit refreshes `last_accessed_at` for LRU eviction.
   */
  async get<T = unknown>(
    key: string,
    artifactKind: ArtifactKind,
  ): Promise<T | null> {
    const entry = await this.cacheRepo.findOne({
      where: { cacheKey: key, artifactKind },
    });
    if (!entry) return null;

    let blob: Buffer | null;
    try {
      blob = await this.blobStore.get(entry.blobPath);
    } catch (err) {
      // Blob store unreachable — per plan's failure modes, proceed
      // as if miss. Caller falls back to re-computation.
      this.logger.warn(
        `blob store read failed for ${key}/${artifactKind}: ${(err as Error).message}`,
      );
      return null;
    }

    if (!blob) {
      // Metadata row but missing blob — stale entry from an
      // interrupted eviction, drop it.
      this.logger.warn(
        `cache metadata without blob: ${key}/${artifactKind}, removing`,
      );
      await this.cacheRepo.delete({ cacheKey: key, artifactKind });
      return null;
    }

    // Touch LRU timestamp. Best-effort — a failed update should NOT
    // fail the read.
    try {
      await this.cacheRepo.update(
        { cacheKey: key, artifactKind },
        { lastAccessedAt: new Date() },
      );
    } catch (err) {
      this.logger.debug(
        `LRU touch failed for ${key}/${artifactKind}: ${(err as Error).message}`,
      );
    }

    return this.decode<T>(blob);
  }

  /**
   * UPSERTs a cache entry and writes the blob. If `sizeBytes` is
   * omitted we fall back to the encoded payload length.
   */
  async put<T = unknown>(
    key: string,
    artifactKind: ArtifactKind,
    value: T,
    sizeBytes?: number,
    orgId?: string | null,
  ): Promise<void> {
    const blobPath = buildBlobPath(artifactKind, key);
    const encoded = this.encode(value);
    const size = sizeBytes ?? encoded.byteLength;

    await this.blobStore.put(blobPath, encoded);

    const now = new Date();
    const existing = await this.cacheRepo.findOne({
      where: { cacheKey: key, artifactKind },
    });
    if (existing) {
      existing.blobPath = blobPath;
      existing.sizeBytes = size;
      existing.lastAccessedAt = now;
      if (orgId !== undefined) existing.orgId = orgId;
      await this.cacheRepo.save(existing);
    } else {
      await this.cacheRepo.save(
        this.cacheRepo.create({
          cacheKey: key,
          artifactKind,
          blobPath,
          sizeBytes: size,
          lastAccessedAt: now,
          orgId: orgId ?? null,
        }),
      );
    }
  }

  /**
   * Removes every artifact kind for `key`. Blob deletions are
   * best-effort — if one fails, the metadata row still goes, so
   * orphaned blobs get swept by the eviction service later.
   */
  async invalidate(key: string): Promise<void> {
    const rows = await this.cacheRepo.find({ where: { cacheKey: key } });
    for (const row of rows) {
      try {
        await this.blobStore.delete(row.blobPath);
      } catch (err) {
        this.logger.warn(
          `blob delete failed during invalidate ${key}/${row.artifactKind}: ${(err as Error).message}`,
        );
      }
    }
    if (rows.length > 0) {
      await this.cacheRepo.delete({ cacheKey: key });
    }
  }

  private encode(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value ?? null), 'utf8');
  }

  private decode<T>(buf: Buffer): T {
    // Empty buffer decodes as null — callers treat that as miss.
    if (buf.byteLength === 0) return null as T;
    return JSON.parse(buf.toString('utf8')) as T;
  }
}

/**
 * Byte-level CRLF/CR → LF normalization. Avoids a UTF-8 decode when
 * the input is already a Buffer. Linear scan, single allocation.
 */
function normalizeLineEndings(buf: Buffer): Buffer {
  // Fast path: no CR bytes at all.
  if (buf.indexOf(0x0d) === -1) return buf;

  const out = Buffer.allocUnsafe(buf.length); // at most same size
  let w = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d) {
      out[w++] = 0x0a; // CR → LF
      if (i + 1 < buf.length && buf[i + 1] === 0x0a) {
        i++; // swallow the LF of a CRLF pair
      }
    } else {
      out[w++] = b;
    }
  }
  return out.subarray(0, w);
}

// Re-export so consumers import types from one place.
export { ArtifactKind, ARTIFACT_KINDS } from './types';
