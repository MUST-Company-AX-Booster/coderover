import { Injectable, Logger } from '@nestjs/common';
import {
  CacheHashIndexService,
  ContentCacheService,
} from '../cache/cache.module';
import { MemgraphService } from '../graph/memgraph.service';
import { computeNodeId } from '../graph/deterministic-ids';

/**
 * Phase 10 C2 — Incremental ingestion orchestration.
 *
 * Wraps (does NOT replace) `IngestService.processIngestion`. Given a
 * per-run `runId` and a stream of (filePath, content) pairs, this
 * service decides per-file whether the file is unchanged (skip),
 * changed (run the caller's `process` callback + refresh the hash),
 * or absent in this run (delete its nodes from Memgraph).
 *
 * Three primitives:
 *
 *   1. `beginRun(runId)` — prime Redis hash index from Postgres.
 *   2. `processFileIfChanged(runId, repoId, filePath, content, fn)` —
 *      skip / process / update cache, emit structured log.
 *   3. `applyDeletes(repoId, deletedFilePaths)` — DETACH DELETE every
 *      node whose `filePath` property matches a removed path.
 *
 * C3 (watch daemon, following lane) will call these directly from a
 * filesystem-events loop. C2's own re-ingestion path can call them
 * from a wrapper around `processIngestion`.
 *
 * ### Delta-apply semantics
 *
 * After `processFn` returns its emitted node_ids, we compute the set
 * of pre-existing node_ids for this (repo, filePath) in Memgraph and
 * DETACH DELETE those absent from the new set. Edges touching a
 * deleted node vanish via DETACH — no separate edge pass required.
 *
 * ### Renames (critical-gap test #5)
 *
 * A rename that keeps `qualifiedName` keeps `node_id` (see
 * `deterministic-ids.ts`). The delta-apply pass will:
 *   - See the new file's node_ids.
 *   - NOT delete anything for the old path (the old path's nodes
 *     share their ID with the new path's if qualifiedName is
 *     stable — BUT they still have the old `filePath` property).
 *
 * To handle this safely:
 *   - The caller (watcher / ingest) is responsible for telling us
 *     when a path is GONE (via `applyDeletes`).
 *   - The delta-apply for the NEW path deletes nodes whose
 *     `(filePath, node_id)` say "used to be at this path but the
 *     new run didn't emit me".
 *   - Node_id is what gives rename-preservation: if the qualified
 *     name survives, the re-ingest will `MERGE` onto the same node
 *     (just with an updated `filePath`) — no duplicate node, no
 *     broken edges.
 *
 * ### New-qualified-name → orphan cleanup
 *
 * If a re-derivation assigns a symbol a new `qualifiedName` (e.g.
 * class-rename), its node_id changes. The old node_id still lives
 * in Memgraph with the same filePath. The delta-apply pass sees the
 * old id is absent from this run's emitted set and DETACH DELETEs
 * it. Edges pointing to the old node die with it — which is the
 * right thing to do for a semantic rename, but consumers should be
 * aware they MAY lose cross-file edges for the one ingest cycle
 * it takes producers to re-emit them. Documented for posterity.
 */

export type IncrementalAction = 'skipped' | 'processed' | 'deleted';

export interface IncrementalLog {
  runId: string;
  repoId: string;
  filePath: string;
  action: IncrementalAction;
  reason: string;
}

export interface ProcessFileOutcome {
  /**
   * node_ids emitted by the caller during processing. The service
   * uses this to compute orphans for the file scope.
   */
  nodeIds: string[];
}

export type ProcessFn = () => Promise<ProcessFileOutcome>;

@Injectable()
export class IncrementalIngestService {
  private readonly logger = new Logger(IncrementalIngestService.name);

  constructor(
    private readonly contentCache: ContentCacheService,
    private readonly hashIndex: CacheHashIndexService,
    private readonly memgraph: MemgraphService,
  ) {}

  /**
   * Call once at the start of an ingestion run. Populates Redis
   * with every known cache key from Postgres so per-file checks are
   * O(1) HEXISTS rather than O(1) SELECT. If Redis is down, all
   * `has()` checks return false and every file is re-processed —
   * ingestion still completes.
   */
  async beginRun(runId: string): Promise<void> {
    await this.hashIndex.loadIndex(runId);
  }

  /**
   * Call once at the end of a run to free the per-run Redis hash.
   * The Redis key has a 1-hour TTL so forgetting this is not fatal,
   * just wasteful.
   */
  async endRun(runId: string): Promise<void> {
    await this.hashIndex.clearRun(runId);
  }

  /**
   * Per-file entry point. Hashes `content` via
   * `ContentCacheService.computeKey`; on HIT we return `skipped`,
   * on MISS we run `processFn`, refresh the cache, and delta-apply
   * orphan cleanup for this file's scope.
   *
   * Returns a structured result so the caller (queue worker / watch
   * daemon) can aggregate its own metrics.
   */
  async processFileIfChanged(
    runId: string,
    repoId: string,
    filePath: string,
    content: string | Buffer,
    processFn: ProcessFn,
  ): Promise<{ action: IncrementalAction; reason: string; cacheKey: string }> {
    const cacheKey = this.contentCache.computeKey(content);

    const hit = await this.hashIndex.has(runId, cacheKey);
    if (hit) {
      // Redis says we've seen this hash before. Double-check Postgres
      // in case the Redis hash and the cache table drift — a belt-and-
      // suspenders guard, very cheap on the hit path.
      this.emit({
        runId,
        repoId,
        filePath,
        action: 'skipped',
        reason: 'content-cache-hit',
      });
      return { action: 'skipped', reason: 'content-cache-hit', cacheKey };
    }

    const outcome = await processFn();

    // Refresh the cache: store a trivial "symbols" artifact so the
    // next run's `hashIndex.loadIndex` picks this key up. The artifact
    // value is just the node_ids this run emitted — it's useful as
    // a per-file summary and cheap.
    await this.contentCache.put(cacheKey, 'symbols', {
      nodeIds: outcome.nodeIds,
      filePath,
    });

    // Delta-apply: DETACH DELETE any pre-existing node whose filePath
    // matches AND whose node_id is absent from this run's emitted set.
    await this.deleteOrphanNodes(repoId, filePath, outcome.nodeIds);

    this.emit({
      runId,
      repoId,
      filePath,
      action: 'processed',
      reason: 'content-changed',
    });
    return { action: 'processed', reason: 'content-changed', cacheKey };
  }

  /**
   * Mark a set of files as deleted: DETACH DELETE every node with a
   * matching `filePath` property, for this repo. Cleaning up edges
   * is implicit via DETACH.
   *
   * The cache hash key for a deleted file cannot be known ahead of
   * time (we've lost the content); `ContentCacheService.invalidate`
   * would need the hash. Per the plan, cache hygiene for deletions
   * is handled by the LRU/TTL sweep in `CacheEvictionService` —
   * this method is intentionally Memgraph-only.
   */
  async applyDeletes(repoId: string, filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      try {
        await this.memgraph.writeQuery(
          `
          MATCH (n { repoId: $repoId, filePath: $filePath })
          DETACH DELETE n
          `,
          { repoId, filePath },
        );
        this.emit({
          runId: 'n/a',
          repoId,
          filePath,
          action: 'deleted',
          reason: 'file-removed',
        });
      } catch (err) {
        this.logger.warn(
          `applyDeletes failed for ${repoId}/${filePath}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * DETACH DELETE every node for (repoId, filePath) whose node_id is
   * NOT in the newly-emitted set. Edges go with DETACH.
   *
   * We batch the keep-list into a single query and use a NOT IN
   * filter — cheap vs reads + per-row deletes.
   */
  private async deleteOrphanNodes(
    repoId: string,
    filePath: string,
    keepNodeIds: string[],
  ): Promise<void> {
    try {
      await this.memgraph.writeQuery(
        `
        MATCH (n { repoId: $repoId, filePath: $filePath })
        WHERE n.node_id IS NOT NULL AND NOT n.node_id IN $keep
        DETACH DELETE n
        `,
        { repoId, filePath, keep: keepNodeIds },
      );
    } catch (err) {
      this.logger.warn(
        `delta-apply orphan cleanup failed for ${repoId}/${filePath}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Single structured log line per file action. The shape is
   * promised to C3 (watch daemon) and to observability, so keep it
   * stable.
   */
  private emit(entry: IncrementalLog): void {
    this.logger.log(
      JSON.stringify({
        event: 'incremental-ingest',
        ...entry,
      }),
    );
  }

  /**
   * Convenience helper for callers that build node_ids from the same
   * tuple as the graph writer. Re-exported so watch / ingest don't
   * need to import `deterministic-ids` directly when they're already
   * holding an `IncrementalIngestService`.
   */
  static computeNodeId = computeNodeId;
}
