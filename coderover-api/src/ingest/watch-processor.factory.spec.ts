/**
 * Phase 10 C3 — WatchProcessorFactory tests.
 *
 * Verifies the factory's contract with `WatchDaemonService` →
 * `IncrementalIngestService`:
 *
 *   - `build({ repoId, absolutePath, relativePath, action: 'change' })`
 *     returns a `ProcessFn` that chunks, pre-deletes prior rows,
 *     embeds + upserts, and reports emitted node_ids.
 *   - 'add' behaves identically to 'change' (both re-index).
 *   - 'unlink' short-circuits (deletes are routed via
 *     `IncrementalIngestService.applyDeletes` upstream — the ProcessFn
 *     should never reach the chunker).
 *   - If chunking throws, the error bubbles and no DB write happens.
 *   - Empty / non-indexable files still pre-delete prior chunks so
 *     stale rows don't linger.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { WatchProcessorFactory } from './watch-processor.factory';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';
import { CodeChunk } from '../entities/code-chunk.entity';
import { Repository } from 'typeorm';

type Mocked<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? jest.Mock : T[K];
};

function makeChunker(): Mocked<Pick<ChunkerService, 'chunkFile'>> {
  return {
    chunkFile: jest.fn(),
  };
}

function makeEmbedder(): Mocked<Pick<EmbedderService, 'embedAndUpsert'>> {
  return {
    embedAndUpsert: jest.fn().mockResolvedValue({
      chunksProcessed: 0,
      chunksUpserted: 0,
      chunksDeleted: 0,
      errors: [],
      durationMs: 0,
    }),
  };
}

function makeChunkRepo(): Mocked<Pick<Repository<CodeChunk>, 'delete'>> {
  return {
    delete: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
  };
}

function makeFactory() {
  const chunker = makeChunker();
  const embedder = makeEmbedder();
  const chunkRepo = makeChunkRepo();
  const factory = new WatchProcessorFactory(
    chunker as unknown as ChunkerService,
    embedder as unknown as EmbedderService,
    chunkRepo as unknown as Repository<CodeChunk>,
  );
  return { factory, chunker, embedder, chunkRepo };
}

describe('WatchProcessorFactory', () => {
  let tmpRoot: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-proc-'));
    tmpFile = path.join(tmpRoot, 'foo.ts');
    fs.writeFileSync(tmpFile, 'export class Foo {}\n');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('build({action:"change"}) returns a ProcessFn that chunks + pre-deletes + embeds + emits nodeIds', async () => {
    const { factory, chunker, embedder, chunkRepo } = makeFactory();
    chunker.chunkFile.mockReturnValue([
      {
        chunkText: '// header\nexport class Foo {}',
        rawText: 'export class Foo {}',
        filePath: 'foo.ts',
        moduleName: null,
        lineStart: 1,
        lineEnd: 1,
        commitSha: 'watch-123',
        symbols: [
          {
            name: 'Foo',
            kind: 'class' as const,
            exported: true,
            decorators: [],
            lineStart: 1,
            lineEnd: 1,
          },
          {
            name: 'helper',
            kind: 'function' as const,
            exported: false,
            decorators: [],
            lineStart: 2,
            lineEnd: 2,
          },
        ],
        nestRole: 'unknown',
        imports: [],
        exports: ['Foo'],
        language: 'typescript' as const,
        framework: null,
      },
    ]);

    const processFn = factory.build({
      repoId: 'repo-1',
      absolutePath: tmpFile,
      relativePath: 'foo.ts',
      action: 'change',
    });

    const outcome = await processFn();

    // Pre-delete was issued with the right scope.
    expect(chunkRepo.delete).toHaveBeenCalledTimes(1);
    expect(chunkRepo.delete).toHaveBeenCalledWith({
      repoId: 'repo-1',
      filePath: 'foo.ts',
    });

    // Chunker received the (filePath, content) with a synthesized
    // commit sha — we don't pin the sha value, just that it exists.
    expect(chunker.chunkFile).toHaveBeenCalledTimes(1);
    const chunkArg = chunker.chunkFile.mock.calls[0]![0];
    expect(chunkArg.filePath).toBe('foo.ts');
    expect(chunkArg.content).toContain('export class Foo');
    expect(typeof chunkArg.commitSha).toBe('string');

    // Embedder saw the chunker output + repoId.
    expect(embedder.embedAndUpsert).toHaveBeenCalledTimes(1);
    const [embedChunks, embedRepoId] = embedder.embedAndUpsert.mock.calls[0]!;
    expect(embedChunks).toHaveLength(1);
    expect(embedRepoId).toBe('repo-1');

    // Node ids emitted — one per symbol.
    expect(outcome.nodeIds).toHaveLength(2);
    expect(outcome.nodeIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('build({action:"add"}) reindexes the same way as "change"', async () => {
    const { factory, chunker, embedder, chunkRepo } = makeFactory();
    chunker.chunkFile.mockReturnValue([
      {
        chunkText: 'x',
        rawText: 'x',
        filePath: 'foo.ts',
        moduleName: null,
        lineStart: 1,
        lineEnd: 1,
        commitSha: 'watch',
        symbols: [],
        nestRole: 'unknown',
        imports: [],
        exports: [],
        language: 'typescript' as const,
        framework: null,
      },
    ]);

    const processFn = factory.build({
      repoId: 'r',
      absolutePath: tmpFile,
      relativePath: 'foo.ts',
      action: 'add',
    });
    const outcome = await processFn();

    expect(chunkRepo.delete).toHaveBeenCalled();
    expect(chunker.chunkFile).toHaveBeenCalled();
    expect(embedder.embedAndUpsert).toHaveBeenCalled();
    expect(outcome.nodeIds).toEqual([]);
  });

  it('build({action:"unlink"}) short-circuits — no chunking, no embedding, no pre-delete', async () => {
    const { factory, chunker, embedder, chunkRepo } = makeFactory();

    const processFn = factory.build({
      repoId: 'r',
      absolutePath: tmpFile,
      relativePath: 'foo.ts',
      action: 'unlink',
    });
    const outcome = await processFn();

    expect(chunker.chunkFile).not.toHaveBeenCalled();
    expect(embedder.embedAndUpsert).not.toHaveBeenCalled();
    expect(chunkRepo.delete).not.toHaveBeenCalled();
    expect(outcome).toEqual({ nodeIds: [] });
  });

  it('empty chunker output still pre-deletes stale rows + returns empty nodeIds', async () => {
    const { factory, chunker, embedder, chunkRepo } = makeFactory();
    chunker.chunkFile.mockReturnValue([]);

    const processFn = factory.build({
      repoId: 'r',
      absolutePath: tmpFile,
      relativePath: 'package.json',
      action: 'change',
    });
    const outcome = await processFn();

    expect(chunkRepo.delete).toHaveBeenCalledWith({
      repoId: 'r',
      filePath: 'package.json',
    });
    // No embedder call when there's nothing to embed.
    expect(embedder.embedAndUpsert).not.toHaveBeenCalled();
    expect(outcome).toEqual({ nodeIds: [] });
  });

  it('chunker error propagates — no embedder call, no DB pre-delete', async () => {
    const { factory, chunker, embedder, chunkRepo } = makeFactory();
    chunker.chunkFile.mockImplementation(() => {
      throw new Error('boom');
    });

    const processFn = factory.build({
      repoId: 'r',
      absolutePath: tmpFile,
      relativePath: 'foo.ts',
      action: 'change',
    });

    await expect(processFn()).rejects.toThrow('boom');
    expect(embedder.embedAndUpsert).not.toHaveBeenCalled();
    // Pre-delete happens AFTER chunking in our implementation, so a
    // chunker throw should leave the DB untouched.
    expect(chunkRepo.delete).not.toHaveBeenCalled();
  });

  it('missing absolute file propagates a readFileSync error', async () => {
    const { factory, chunker, embedder, chunkRepo } = makeFactory();

    const processFn = factory.build({
      repoId: 'r',
      absolutePath: path.join(tmpRoot, 'does-not-exist.ts'),
      relativePath: 'does-not-exist.ts',
      action: 'change',
    });

    await expect(processFn()).rejects.toThrow(/ENOENT|no such file/i);
    expect(chunker.chunkFile).not.toHaveBeenCalled();
    expect(embedder.embedAndUpsert).not.toHaveBeenCalled();
    expect(chunkRepo.delete).not.toHaveBeenCalled();
  });
});
