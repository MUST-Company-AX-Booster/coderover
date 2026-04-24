# Phase 10 Runbook

**Audience:** ops / oncall engineer triaging a live CodeRover deployment.
**Companion to:** [`runbook-phase9.md`](./runbook-phase9.md)
(Phase 9 feature flags, GitHub App, token caps, rollback).

Cross-links:
- [`SETUP.md`](../SETUP.md) — first-run setup and env vars.
- [`ROADMAP.md`](../ROADMAP.md) — what shipped in Phase 10, what's coming.
- [`CHANGELOG.md`](../CHANGELOG.md) — migration list and deprecations.

If you're opening this in anger: jump to the section matching the symptom.

| Symptom                                          | Section                                            |
| ------------------------------------------------ | -------------------------------------------------- |
| Ingest is stuck / queue not draining             | [§1 Ingest stuck](#1-ingest-stuck)                 |
| `coderover-watch` running but no files processed | [§2 Watch daemon not processing](#2-watch-daemon-not-processing) |
| New graph edges land as `AMBIGUOUS`              | [§3 Confidence tags missing](#3-confidence-tags-missing-on-new-edges) |
| `/bench:reingest` hit rate low                   | [§4 Cache hit rate low](#4-cache-hit-rate-low)     |
| Agent reports `isError: true` on MCP call        | [§5 MCP tool call fails](#5-mcp-tool-call-returns-iserror) |
| Need to back out Phase 10                        | [§6 Rollback procedure](#6-rollback-procedure)     |

---

## 1. Ingest stuck

### Diagnose

1. **Bull queue depth.** Phase 9 shipped `coderover_agent_runs_queued`;
   Phase 10 ingest reuses the Bull infra. Eyeball:
   ```
   curl -s http://localhost:3001/metrics | grep -E 'coderover_agent_runs_(queued|active)'
   ```
2. **ContentCache hit rate.** If hit rate is near zero the cache is
   churning — most likely Redis is unreachable, or the S3 blob store is
   misconfigured and every `put` silently succeeds but `get` returns miss.
   <!-- TODO: verify exact Prometheus metric name once the cache service exports one — today the hit/miss counts are logged through MetricsService but the metric name is not set in code. -->
3. **Ingest logs.** Tail the API pod and filter on structured ingest
   events:
   ```
   grep -E '"event":"ingest"|"event":"cache"' <log>
   ```
   Look for `cache-miss-put-failed` or `blob-store-unreachable` entries
   from `src/cache/content-cache.service.ts`.

### Kill / retry

- **Drain a single job.** From the admin UI, Repositories → Reingest.
  This enqueues with the same idempotency key so the C2 delta apply
  picks up where it left off.
- **Nuke and re-run.** `coderover cache purge --repo <id>` invalidates
  the per-repo Redis hash index; the next ingest re-hashes from scratch.
  This is safe — ingestion is idempotent thanks to the deterministic
  node/edge IDs (C2-bis).

---

## 2. Watch daemon not processing

Phase 10 C3 ships the daemon in **observe-only mode** by default — it
counts events, emits metrics, and does not hit the ingest pipeline until
the processor-wiring follow-up lands. If you're seeing "no ingest
activity" but metrics are healthy, confirm observe-only is the expected
state (see `coderover-api/src/cli/watch.ts` top-of-file comment).

### Diagnose

1. **Queue depth.** `stats.queueDepth` printed on shutdown, or the live
   gauge:
   ```
   curl -s http://localhost:3001/metrics | grep coderover_watch_queue_depth
   ```
   Above 1000 = back-pressure is triggering (see §4 Metrics below).
2. **Back-pressure / token cap.** When `TokenCapService` rejects a
   batch, the daemon emits a `watch-paused` structured log:
   ```
   grep '"event":"watch-paused"' <log>
   ```
   Match against `watch-resumed` to see how long the pause lasted. The
   counter:
   ```
   curl -s http://localhost:3001/metrics | grep coderover_watch_back_pressure_total
   ```
3. **Ignore-set dropping everything.** Run with `--verbose` to see
   per-path debounce decisions. If everything is being ignored, check
   the repo's `.gitignore` — the built-in ignore set is additive on top
   of it.

### Forcibly flush

- Send `SIGINT` — the daemon drains the queue, prints final stats, and
  closes cleanly. Restart to pick up fresh config.
- No REST endpoint to flush the daemon remotely today.
  <!-- TODO: expose a `POST /watch/:repoId/flush` admin endpoint once the processor wiring lands; the daemon already exposes a `handle.stop()` primitive. -->

---

## 3. Confidence tags missing on new edges

Symptom: new graph edges arrive with `confidence = AMBIGUOUS` when they
should be `EXTRACTED` (AST-derived) or `INFERRED` (LLM-derived).

### Diagnose

1. **`ConfidenceTagger` wired at the producer site?** B2 wired nine
   producer sites. Confirm the write path calls
   `ConfidenceTagger.tag(evidence)` rather than writing a raw tag. Grep:
   ```
   grep -rn "ConfidenceTagger" coderover-api/src/graph coderover-api/src/ingest coderover-api/src/pr-review
   ```
   If a new producer slipped in without the tagger, that's the bug.
2. **`edge_producer_audit` table has rows?** The tagger is supposed to
   leave an audit trail per write. Query:
   ```sql
   SELECT producer_kind, COUNT(*), MAX(created_at)
   FROM edge_producer_audit
   WHERE org_id = $1
   GROUP BY 1
   ORDER BY 2 DESC;
   ```
   If the producer you expect is absent from the result, it's not
   calling the tagger.
3. **Backfill job stalled?** The B1 one-time retag job walks the audit
   table and promotes `AMBIGUOUS` edges. It batches by file scope and
   runs off-peak under its own token bucket — if the job is disabled or
   the bucket is empty, old rows stay at `AMBIGUOUS`. Check the Bull
   queue for the retag worker.

---

## 4. Cache hit rate low

The Phase 10 C1 acceptance bar is **≥ 99% hit rate** on a re-ingest of
unchanged content — that's what the `reingest_unchanged` benchmark
gates on. Below 95% in prod means cache is churning and you're burning
compute + LLM budget.

### Diagnose

1. **Redis reachable.** The `ContentCacheService` loads the hash index
   into Redis at run start; an unreachable Redis falls back to
   per-file Postgres lookups and tanks throughput. Confirm:
   ```
   redis-cli -h $REDIS_HOST -p $REDIS_PORT ping
   ```
2. **Blob store.** Prod is typically S3-backed. Misconfigured bucket
   policy or region means `put` silently succeeds locally but the blob
   isn't visible on the next `get`. Hit the S3 API directly:
   ```
   aws s3 ls s3://$BUCKET/cache/ast/ | head
   ```
   `cache/{kind}/{key[0:2]}/{key[2:4]}/{key}.bin` is the layout — see
   migration 023's header comment.
3. **Eviction aggression.** The LRU sweep uses
   `cache_entries.last_accessed_at` + a 90-day TTL. If a sweep ran
   recently and evicted too much, `cache_entries` will be
   small vs the repo size. Rule of thumb: row count should be > file
   count × avg artifact-kinds-per-file (~4).
4. **Run the benchmark.** `npm run bench:reingest` from
   `coderover-api/` reproduces the hot path with a known corpus:
   ```
   cd coderover-api
   npm run bench:reingest
   ```
   Pass gate: hit rate ≥ 99% and p95 ≤ 100ms. Failure modes are called
   out in `benchmarks/reingest-unchanged.bench.ts`.

---

## 5. MCP tool call returns isError

The agent (Claude Code, Cursor, Aider, Codex, Gemini CLI) reports
`{ "isError": true, ... }` on a tool call. Walk this ladder:

1. **Token valid?** Tokens have `exp` (default 30 days — see A4). An
   expired token fails with `401 token_expired`. Mint a fresh one:
   ```
   curl -X POST http://localhost:3001/auth/tokens \
     -H "Authorization: Bearer $USER_JWT" \
     -H "Content-Type: application/json" \
     -d '{"scope":["search:read","citations:read","graph:read"],"kind":"mcp"}'
   ```
2. **Scope set?** `ScopeGuard` returns `403` if the JWT's `scope`
   array is missing the required scope for the route. Cross-check:
   - `/search/*` requires `search:read`
   - `/citations/*` requires `citations:read`
   - `/graph/*` + `/mcp/tools/query-code-graph` require `graph:read`
3. **Token revoked mid-session?** A4 shipped the revocation cache
   (30s per-process). Revoked tokens fail within 30 seconds of the
   admin action. Check the revocation log:
   ```sql
   SELECT id, label, revoked_at, revoked_reason
   FROM revoked_tokens
   WHERE user_id = $1 AND revoked_at IS NOT NULL
   ORDER BY revoked_at DESC LIMIT 10;
   ```
4. **Backend version match.** The client + backend negotiate
   capabilities at handshake. Call it directly:
   ```
   curl -s http://localhost:3001/mcp/capabilities | jq .
   ```
   The response advertises protocol version, tool list, and feature
   flags. If the client is newer than the backend, the handshake fails
   with a clear "backend too old" error — upgrade the backend or pin
   the client to an older tag (`npx @coderover/mcp@0.10.0`).
5. **Network / TLS.** Remote mode hits the backend over HTTPS. Corp
   MITM proxies sometimes break the TLS chain; the `doctor` subcommand
   surfaces this:
   ```
   npx @coderover/mcp@latest doctor
   ```

---

## 6. Rollback procedure

The four Phase 10 migrations are **additive and revert in reverse order**.
All four ship a working `down()`. Data loss on revert:

| Migration                                 | Revert safe?             | What is lost                                             |
| ----------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `023_cache_metadata`                      | Yes, additive            | `cache_entries` table (blob store survives independently). |
| `022_revoked_tokens`                      | Yes, additive            | `revoked_tokens` table. Any MCP tokens minted via A4 remain valid on signature + exp but can't be revoked. |
| `021_phase10_backfill_confidence_defaults`| Caveat                   | Unrolled rows in `rag_citations` / `pr_review_findings` are deleted. The source JSONB on `chat_messages.source_chunks` and `pr_reviews.findings.items` is untouched — data is recoverable. |
| `020_phase10_confidence_schema`           | Yes, additive            | `confidence_tag` enum + four new tables. Graph-edge confidence properties in Memgraph persist; they become dead columns until 020 is re-applied. |

### Steps

```bash
cd coderover-api

# Revert in strict reverse order. Each invocation reverts ONE migration.
npm run migration:revert    # reverts 023
npm run migration:revert    # reverts 022
npm run migration:revert    # reverts 021
npm run migration:revert    # reverts 020
```

Then:

- Deploy the pre-Phase-10 API image.
- Restart. The `graph_migrations` tracker has been dropped; the startup
  Cypher runner is a no-op on the pre-Phase-10 path.
- MCP clients will fail at the handshake against the pre-Phase-10
  backend (no `/mcp/capabilities`). Communicate to design partners
  before rolling back.

### Partial rollback (preferred)

If only one workstream is burning, revert that workstream's feature
flag rather than the schema:

- **MCP issuing bad tokens** — revoke all active MCP tokens via the
  admin UI; leave migration 022 in place.
- **Confidence tagger miscategorizing** — set `confidence.enabled=false`
  in the admin settings; the UI falls back to "no mark" rendering.
  <!-- TODO: verify the exact feature-flag key once Admin settings UI surfaces it for B2. The plan spec says "gate behind feature flag for first 2 weeks" but the key name is not pinned in code. -->
- **Watch daemon flooding** — stop `coderover-watch` processes; the
  backend is unaffected.

---

## Metrics to watch (Prometheus)

Scrape `http://localhost:3001/metrics`.

| Metric                                                    | Threshold                                      | Meaning                                              |
| --------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `coderover_watch_queue_depth{repoId}`                     | > 1000 sustained = back-pressure triggering    | Daemon can't keep up with FS events; see §2.         |
| `coderover_watch_back_pressure_total{repoId}`             | Non-zero = token cap engaging                  | `TokenCapService` is pausing batches; see §2.        |
| `coderover_watch_events_total{repoId, action}`            | Delta > 0 = daemon is seeing events            | Sanity check that `@parcel/watcher` is alive.        |
| `coderover_watch_debounce_seconds` (histogram)            | p95 ~= configured debounce (default 500ms)     | Debounce window performance.                         |
| `coderover_watch_processing_seconds{action}` (histogram)  | p95 ≤ 1000ms                                   | Per-event processing cost; gated by the C5 benchmark.|
| `coderover_watch_lag_seconds{repoId}`                     | < 5s                                           | Wall time from event to final stats emit.            |
| `coderover_agent_runs_queued` (Phase 9 carry-over)        | < 10 sustained                                 | Bull queue depth for agent + ingest workers.         |
| `coderover_cache_hit_rate`                                | > 95%                                          | Trend below 95% = churn; see §4.                     |
| `coderover_embed_requests_total`                          | Spike = cache is missing                       | Every miss burns LLM budget.                         |

<!-- TODO: verify `coderover_cache_hit_rate` and `coderover_embed_requests_total` metric names — searched src/cache and src/ingest/embedder.service.ts and did not find these exact registrations as of 2026-04-17. They may be derived gauges or unshipped. The rest of the names in this table are confirmed by grep in `src/ingest/watch-daemon.service.ts` and `src/ingest/token-cap.service.ts`. -->

---

## See also

- Phase 9 runbook: [`runbook-phase9.md`](./runbook-phase9.md).
- Benchmarks: [`coderover-api/benchmarks/README.md`](../coderover-api/benchmarks/README.md).
- MCP client: [`packages/mcp/README.md`](../packages/mcp/README.md).
- Integration harness: [`packages/mcp-integration/README.md`](../packages/mcp-integration/README.md).
