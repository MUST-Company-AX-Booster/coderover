import { IncrementalIngestService } from './incremental-ingest.service';
import { computeNodeId } from '../graph/deterministic-ids';

/**
 * Phase 10 C2 — incremental ingest tests.
 *
 * Critical-gap coverage:
 *   - #3 sister: unchanged repo → no `processFn` calls (per-file HIT).
 *   - #4: deleted file → DETACH DELETE called with its filePath.
 *   - #5: renamed file (same qualifiedName) → edges preserved — the
 *         delta-apply pass does NOT DETACH DELETE a node whose
 *         node_id is unchanged after rename, and the orphan-cleanup
 *         query keeps it.
 */

function makeContentCache() {
  const putRecords: Array<{ key: string; kind: string; value: any }> = [];
  return {
    putRecords,
    computeKey: (content: string | Buffer) => {
      // Simple reversible stub: key = `hash(${content})`. That's enough
      // for tests to reason about identity; real SHA256 is exercised
      // in content-cache.service.spec.ts.
      const s = typeof content === 'string' ? content : content.toString('utf8');
      return `hash(${s})`;
    },
    put: jest.fn(async (key: string, kind: string, value: unknown) => {
      putRecords.push({ key, kind, value });
    }),
    get: jest.fn(async () => null),
    invalidate: jest.fn(async () => undefined),
  } as any;
}

function makeHashIndex(knownKeys: string[] = []) {
  const known = new Set(knownKeys);
  return {
    known,
    loadIndex: jest.fn(async () => undefined),
    has: jest.fn(async (_runId: string, key: string) => known.has(key)),
    clearRun: jest.fn(async () => undefined),
  } as any;
}

function makeMemgraph() {
  const writes: Array<{ cypher: string; params: any }> = [];
  return {
    writes,
    writeQuery: jest.fn(async (cypher: string, params: any = {}) => {
      writes.push({ cypher, params });
      return [];
    }),
  } as any;
}

describe('IncrementalIngestService', () => {
  it('beginRun calls hashIndex.loadIndex', async () => {
    const cache = makeContentCache();
    const idx = makeHashIndex();
    const mg = makeMemgraph();
    const svc = new IncrementalIngestService(cache, idx, mg);

    await svc.beginRun('run-1');
    expect(idx.loadIndex).toHaveBeenCalledWith('run-1');
  });

  it('endRun calls hashIndex.clearRun', async () => {
    const cache = makeContentCache();
    const idx = makeHashIndex();
    const mg = makeMemgraph();
    const svc = new IncrementalIngestService(cache, idx, mg);

    await svc.endRun('run-1');
    expect(idx.clearRun).toHaveBeenCalledWith('run-1');
  });

  describe('processFileIfChanged', () => {
    it('unchanged repo → no processFn calls (critical-gap #3 sister)', async () => {
      const cache = makeContentCache();
      // Pre-populate the hash index with the key for "abc".
      const knownKey = cache.computeKey('abc');
      const idx = makeHashIndex([knownKey]);
      const mg = makeMemgraph();
      const svc = new IncrementalIngestService(cache, idx, mg);

      const processFn = jest.fn(async () => ({ nodeIds: ['n1'] }));
      const out = await svc.processFileIfChanged(
        'run-1',
        'repo-1',
        'src/a.ts',
        'abc',
        processFn,
      );

      expect(out.action).toBe('skipped');
      expect(out.reason).toBe('content-cache-hit');
      expect(processFn).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      expect(mg.writeQuery).not.toHaveBeenCalled();
    });

    it('changed file → runs processFn, refreshes cache, cleans orphans', async () => {
      const cache = makeContentCache();
      const idx = makeHashIndex(); // nothing known
      const mg = makeMemgraph();
      const svc = new IncrementalIngestService(cache, idx, mg);

      const emittedIds = ['id1', 'id2'];
      const processFn = jest.fn(async () => ({ nodeIds: emittedIds }));

      const out = await svc.processFileIfChanged(
        'run-1',
        'repo-1',
        'src/a.ts',
        'new-content',
        processFn,
      );

      expect(out.action).toBe('processed');
      expect(processFn).toHaveBeenCalledTimes(1);

      // Cache put was called with the computed key and the emitted node IDs.
      expect(cache.put).toHaveBeenCalledTimes(1);
      const putCall = cache.put.mock.calls[0];
      expect(putCall[0]).toBe(cache.computeKey('new-content'));
      expect(putCall[1]).toBe('symbols');
      expect(putCall[2]).toEqual({ nodeIds: emittedIds, filePath: 'src/a.ts' });

      // Orphan-cleanup query was issued scoped to repo + filePath with the keep set.
      expect(mg.writeQuery).toHaveBeenCalledTimes(1);
      const [cypher, params] = mg.writeQuery.mock.calls[0];
      expect(cypher).toMatch(/DETACH DELETE n/);
      expect(cypher).toMatch(/NOT n\.node_id IN \$keep/);
      expect(params).toEqual({
        repoId: 'repo-1',
        filePath: 'src/a.ts',
        keep: emittedIds,
      });
    });

    it('returns the cache key on both paths', async () => {
      const cache = makeContentCache();
      const idx = makeHashIndex();
      const mg = makeMemgraph();
      const svc = new IncrementalIngestService(cache, idx, mg);

      const out = await svc.processFileIfChanged(
        'run-1',
        'repo-1',
        'src/a.ts',
        'content',
        async () => ({ nodeIds: [] }),
      );
      expect(out.cacheKey).toBe(cache.computeKey('content'));
    });
  });

  describe('applyDeletes (critical-gap #4)', () => {
    it('issues DETACH DELETE for each removed file path', async () => {
      const cache = makeContentCache();
      const idx = makeHashIndex();
      const mg = makeMemgraph();
      const svc = new IncrementalIngestService(cache, idx, mg);

      await svc.applyDeletes('repo-1', ['src/gone.ts', 'src/also-gone.ts']);

      expect(mg.writeQuery).toHaveBeenCalledTimes(2);
      const cyphers = mg.writeQuery.mock.calls.map((c: any[]) => c[0] as string);
      for (const c of cyphers) expect(c).toMatch(/DETACH DELETE n/);

      const paths = mg.writeQuery.mock.calls.map((c: any[]) => c[1].filePath);
      expect(paths).toEqual(['src/gone.ts', 'src/also-gone.ts']);
    });

    it('tolerates a Memgraph failure per path (logs + continues)', async () => {
      const cache = makeContentCache();
      const idx = makeHashIndex();
      const mg = makeMemgraph();
      mg.writeQuery = jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([]);
      const svc = new IncrementalIngestService(cache, idx, mg);

      await expect(
        svc.applyDeletes('repo-1', ['src/a.ts', 'src/b.ts']),
      ).resolves.toBeUndefined();
      expect(mg.writeQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('renames preserve edges (critical-gap #5)', () => {
    it('same qualifiedName → same node_id → orphan-cleanup keeps it, no new edge MERGE', async () => {
      // Construct a node_id that represents the method `Widget.render`
      // in its NEW file path — this is the ID that incremental ingest
      // will emit for the renamed file.
      const renamedId = computeNodeId('src/new/widget.ts', 'method', 'Widget.render');

      const cache = makeContentCache();
      const idx = makeHashIndex(); // miss — file content technically differs (new path)
      const mg = makeMemgraph();
      const svc = new IncrementalIngestService(cache, idx, mg);

      const out = await svc.processFileIfChanged(
        'run-1',
        'repo-1',
        'src/new/widget.ts',
        'class Widget { render() {} }',
        async () => ({ nodeIds: [renamedId] }),
      );

      expect(out.action).toBe('processed');

      // Only ONE Memgraph write was issued: the orphan-cleanup query.
      // Critically, no DELETE for the renamed node's id — the keep
      // set contains it.
      expect(mg.writeQuery).toHaveBeenCalledTimes(1);
      const [cypher, params] = mg.writeQuery.mock.calls[0];
      expect(cypher).toMatch(/DETACH DELETE/);
      expect(params.keep).toContain(renamedId);

      // No call to `MERGE`/edge creation paths via this service; those
      // belong to the graph writer. The whole point of rename-preservation
      // is that the EXISTING edge terminating at renamedId survives
      // untouched because the node survives.
    });

    it('re-derived qualifiedName orphans the old node (documented behavior)', async () => {
      // If the class is renamed, qualifiedName changes, id changes.
      const oldId = computeNodeId('src/a.ts', 'class', 'Widget');
      const newId = computeNodeId('src/a.ts', 'class', 'WidgetV2');

      const cache = makeContentCache();
      const idx = makeHashIndex();
      const mg = makeMemgraph();
      const svc = new IncrementalIngestService(cache, idx, mg);

      const out = await svc.processFileIfChanged(
        'run-1',
        'repo-1',
        'src/a.ts',
        'class WidgetV2 {}',
        async () => ({ nodeIds: [newId] }),
      );

      expect(out.action).toBe('processed');
      expect(mg.writeQuery).toHaveBeenCalledTimes(1);
      const [, params] = mg.writeQuery.mock.calls[0];
      // The old id is NOT in the keep set, so it will be DETACH DELETED
      // by the orphan-cleanup query — this is the documented behavior.
      expect(params.keep).not.toContain(oldId);
      expect(params.keep).toContain(newId);
    });
  });
});
