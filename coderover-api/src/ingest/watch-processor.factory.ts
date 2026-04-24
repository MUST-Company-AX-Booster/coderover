import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';
import { CodeChunk } from '../entities/code-chunk.entity';
import {
  ProcessFn,
  ProcessFileOutcome,
} from './incremental-ingest.service';
import { WatchAction } from './watch-daemon.service';
import { computeNodeId } from '../graph/deterministic-ids';

/**
 * Phase 10 C3 — watch-daemon processor factory.
 *
 * `WatchDaemonService.opts.processFnFactory` is called per changed
 * file; this factory returns the `ProcessFn` that
 * `IncrementalIngestService` invokes on a cache miss. The ProcessFn
 * re-chunks the file via `ChunkerService`, re-embeds + upserts via
 * `EmbedderService`, and reports the emitted node_ids so the
 * incremental service can delta-apply Memgraph orphan cleanup for
 * this file's scope.
 *
 * The watch path is intentionally a subset of the full GitHub-clone
 * ingest pipeline: content comes from disk, not from a cloned tree,
 * and we stay in-process (no Bull queue). The heavy lifting —
 * chunking, embedding, pgvector serialization, audit rows, orphan
 * deletes across files — is delegated to the existing services, so
 * we never duplicate their behavior.
 *
 * Pre-delete semantics: `EmbedderService.embedAndUpsert` upserts by
 * `(repo_id, file_path, line_start, line_end)`, which is sufficient
 * when lines are stable. When a file shrinks (old trailing chunks
 * no longer exist), we need an explicit pre-delete of
 * `(repo_id, file_path)` so stale rows from old line ranges don't
 * linger. That's what `chunkRepo.delete(...)` is for.
 *
 * Error handling: any exception bubbles to the ProcessFn caller
 * (`IncrementalIngestService`), which propagates it to the daemon,
 * which catches and logs via its own `handleChange` try/catch.
 * We do NOT swallow here — silently losing a watch re-index is
 * worse than a logged failure.
 */
@Injectable()
export class WatchProcessorFactory {
  private readonly logger = new Logger(WatchProcessorFactory.name);

  constructor(
    private readonly chunker: ChunkerService,
    private readonly embedder: EmbedderService,
    @InjectRepository(CodeChunk)
    private readonly chunkRepo: Repository<CodeChunk>,
  ) {}

  /**
   * Build a `ProcessFn` closing over the target file's identity. The
   * daemon only calls this on 'add' or 'change' — 'unlink' goes
   * through `IncrementalIngestService.applyDeletes` upstream.
   */
  build(args: {
    repoId: string;
    absolutePath: string;
    relativePath: string;
    action: WatchAction;
  }): ProcessFn {
    const { repoId, relativePath, action } = args;

    return async (): Promise<ProcessFileOutcome> => {
      const startedAt = Date.now();

      // 'unlink' should never reach this path — the daemon routes
      // deletes to `IncrementalIngestService.applyDeletes`. Guard
      // defensively so a future refactor doesn't silently corrupt the
      // index.
      if (action === 'unlink') {
        this.logger.warn(
          `watch-process skipping unlink for ${relativePath} — deletes belong to applyDeletes()`,
        );
        return { nodeIds: [] };
      }

      // `IncrementalIngestService` has already read the content and
      // decided this is a cache miss; we re-read here because we
      // receive (repoId, filePath) — not the content buffer — through
      // the factory. In practice the OS page cache makes this cheap.
      // If the file disappears between the daemon's readFileSync and
      // this read (e.g. a rename races), we propagate the error so
      // the caller logs it rather than silently upsert nothing.
      const content = fs.readFileSync(args.absolutePath, 'utf8');

      // Re-chunk the whole file.
      const chunks = this.chunker.chunkFile({
        filePath: relativePath,
        content,
        commitSha: `watch-${startedAt}`,
      });

      if (chunks.length === 0) {
        // Either the file is not indexable (e.g. JSON, binary) or it
        // came back empty. Still clean up any previously-persisted
        // chunks for this path so we don't leave stale rows.
        await this.chunkRepo.delete({ repoId, filePath: relativePath });
        this.logStructured({
          event: 'watch-process',
          repoId,
          filePath: relativePath,
          chunks: 0,
          durationMs: Date.now() - startedAt,
          reason: 'not-indexable-or-empty',
        });
        return { nodeIds: [] };
      }

      // Pre-delete: EmbedderService.upsertChunk uses ON CONFLICT
      // (repo_id, file_path, line_start, line_end). If a file shrinks,
      // chunks from no-longer-existing line ranges would linger. One
      // flat delete by (repo_id, file_path) is cheap and correct.
      await this.chunkRepo.delete({ repoId, filePath: relativePath });

      // Embed + upsert. EmbedderService already handles pgvector
      // formatting, dimension mismatches, audit rows, and the BM25
      // fallback when the embedding provider is down.
      await this.embedder.embedAndUpsert(chunks, repoId);

      // Emit node_ids for the delta-apply pass in
      // `IncrementalIngestService`. We surface class/function/etc.
      // symbols as nodes; empty symbol lists are fine (the delta-apply
      // will then drop any previously-known Memgraph nodes for this
      // path, which matches "content changed, re-derive everything").
      const nodeIds: string[] = [];
      for (const chunk of chunks) {
        for (const sym of chunk.symbols ?? []) {
          nodeIds.push(computeNodeId(relativePath, sym.kind, sym.name));
        }
      }

      this.logStructured({
        event: 'watch-process',
        repoId,
        filePath: relativePath,
        chunks: chunks.length,
        nodeIds: nodeIds.length,
        durationMs: Date.now() - startedAt,
      });

      return { nodeIds };
    };
  }

  private logStructured(payload: Record<string, unknown>): void {
    this.logger.log(JSON.stringify(payload));
  }
}
