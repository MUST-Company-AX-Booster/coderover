import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Phase 10 C1 — Blob storage abstraction for ContentCache.
 *
 * Two implementations:
 *   - LocalFsBlobStore: filesystem-backed. Used when
 *     `CODEROVER_CACHE_BACKEND` is unset or 'local'. Writes under
 *     `CODEROVER_CACHE_DIR ?? './.coderover-cache'`.
 *   - S3BlobStore: S3-compatible (AWS, MinIO, R2). Used when
 *     `CODEROVER_CACHE_BACKEND=s3`. Lazily requires `@aws-sdk/client-s3`
 *     so the dep stays optional — if the package is missing we throw
 *     a clear install-hint when the store is first touched.
 *
 * Every blob path follows the sharded layout
 * `cache/{kind}/{key[0:2]}/{key[2:4]}/{key}.bin` to avoid directory
 * hotspots on local FS (git-objects style fan-out).
 */
export interface BlobStore {
  get(blobPath: string): Promise<Buffer | null>;
  put(blobPath: string, data: Buffer): Promise<void>;
  delete(blobPath: string): Promise<void>;
  exists(blobPath: string): Promise<boolean>;
}

export const BLOB_STORE = 'CODEROVER_BLOB_STORE';

/**
 * Build the sharded blob path for a cache entry. Keeps FS fan-out low
 * (256 top-level dirs per kind, 256 under each) and mirrors the
 * git-objects layout so operators already understand it.
 */
export function buildBlobPath(kind: string, key: string): string {
  if (key.length < 4) {
    throw new Error(`cache key too short for sharding: ${key}`);
  }
  return path.posix.join(
    'cache',
    kind,
    key.slice(0, 2),
    key.slice(2, 4),
    `${key}.bin`,
  );
}

@Injectable()
export class LocalFsBlobStore implements BlobStore {
  private readonly logger = new Logger(LocalFsBlobStore.name);
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir =
      rootDir ??
      process.env.CODEROVER_CACHE_DIR ??
      path.resolve(process.cwd(), '.coderover-cache');
  }

  private absPath(blobPath: string): string {
    // Guard against path traversal — blobPath is always produced by
    // buildBlobPath, but defense-in-depth is cheap here.
    const resolved = path.resolve(this.rootDir, blobPath);
    if (!resolved.startsWith(path.resolve(this.rootDir) + path.sep) &&
        resolved !== path.resolve(this.rootDir)) {
      throw new Error(`blob path escaped root: ${blobPath}`);
    }
    return resolved;
  }

  async get(blobPath: string): Promise<Buffer | null> {
    const abs = this.absPath(blobPath);
    try {
      return await fsp.readFile(abs);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(blobPath: string, data: Buffer): Promise<void> {
    const abs = this.absPath(blobPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // Write-then-rename for atomicity — readers never see a partial file.
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, abs);
  }

  async delete(blobPath: string): Promise<void> {
    const abs = this.absPath(blobPath);
    try {
      await fsp.unlink(abs);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  async exists(blobPath: string): Promise<boolean> {
    const abs = this.absPath(blobPath);
    try {
      await fsp.access(abs, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * S3-compatible blob store. Loads `@aws-sdk/client-s3` lazily so that
 * the dep is optional — projects using the local backend never incur
 * the install. First call to any method loads the SDK; a missing
 * package surfaces as a clear actionable error.
 */
@Injectable()
export class S3BlobStore implements BlobStore {
  private readonly logger = new Logger(S3BlobStore.name);
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private clientPromise: Promise<any> | null = null;

  constructor(config: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }) {
    this.bucket = config.bucket;
    this.region = config.region;
    this.endpoint = config.endpoint;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
  }

  private async getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let mod: any;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          mod = require('@aws-sdk/client-s3');
        } catch (err) {
          throw new Error(
            'S3 cache backend requested (CODEROVER_CACHE_BACKEND=s3) but ' +
              "`@aws-sdk/client-s3` is not installed. Run `npm i @aws-sdk/client-s3` " +
              'or switch to CODEROVER_CACHE_BACKEND=local.',
          );
        }
        const { S3Client } = mod;
        return new S3Client({
          region: this.region,
          endpoint: this.endpoint,
          forcePathStyle: !!this.endpoint, // MinIO-compat
          credentials:
            this.accessKeyId && this.secretAccessKey
              ? {
                  accessKeyId: this.accessKeyId,
                  secretAccessKey: this.secretAccessKey,
                }
              : undefined,
        });
      })();
    }
    return this.clientPromise;
  }

  async get(blobPath: string): Promise<Buffer | null> {
    const client = await this.getClient();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: blobPath }),
      );
      const body = res.Body;
      if (!body) return null;
      return await streamToBuffer(body);
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async put(blobPath: string, data: Buffer): Promise<void> {
    const client = await this.getClient();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: blobPath, Body: data }),
    );
  }

  async delete(blobPath: string): Promise<void> {
    const client = await this.getClient();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: blobPath }),
    );
  }

  async exists(blobPath: string): Promise<boolean> {
    const client = await this.getClient();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: blobPath }),
      );
      return true;
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }
}

/**
 * Factory selected by env. Kept as a plain function so the module
 * provider stays a one-liner and tests can construct stores directly.
 */
export function blobStoreFromEnv(config: ConfigService): BlobStore {
  const backend = (
    config.get<string>('CODEROVER_CACHE_BACKEND') ??
    process.env.CODEROVER_CACHE_BACKEND ??
    'local'
  ).toLowerCase();

  if (backend === 's3') {
    const bucket = config.get<string>('CACHE_S3_BUCKET') ?? process.env.CACHE_S3_BUCKET;
    const region =
      config.get<string>('CACHE_S3_REGION') ?? process.env.CACHE_S3_REGION ?? 'us-east-1';
    if (!bucket) {
      throw new Error(
        'CODEROVER_CACHE_BACKEND=s3 but CACHE_S3_BUCKET is not set.',
      );
    }
    return new S3BlobStore({
      bucket,
      region,
      endpoint:
        config.get<string>('CACHE_S3_ENDPOINT') ?? process.env.CACHE_S3_ENDPOINT,
      accessKeyId:
        config.get<string>('CACHE_S3_ACCESS_KEY_ID') ??
        process.env.CACHE_S3_ACCESS_KEY_ID,
      secretAccessKey:
        config.get<string>('CACHE_S3_SECRET_ACCESS_KEY') ??
        process.env.CACHE_S3_SECRET_ACCESS_KEY,
    });
  }

  return new LocalFsBlobStore();
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  // Support both Node Readable streams and web ReadableStream (SDK v3
  // returns different types depending on environment).
  if (stream && typeof stream.transformToByteArray === 'function') {
    const arr: Uint8Array = await stream.transformToByteArray();
    return Buffer.from(arr);
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
