# Phase 11 Wave 3 benchmarks

Manually-run harnesses for the three Phase 11 §3 performance targets.

## Usage

```
# from packages/mcp/
npx ts-node benchmarks/index-10k.bench.ts         # initial-index (10k LOC ≤60s)
npx ts-node benchmarks/reingest-1-file.bench.ts   # incremental (1 file ≤2s)
npx ts-node benchmarks/query-p95.bench.ts         # query latency (p95 ≤200ms)

# type-check only
node_modules/.bin/tsc -p benchmarks/tsconfig.json --noEmit

# integrity spec for the harness utilities
node_modules/.bin/jest --config benchmarks/jest.config.ts
```

## What's measured

- `index_10k_loc` — synthesize 200 files × 50 lines and run the full
  walker → chunker → symbol → import → embed (mock) → SQLite pipeline.
  Fails if wall_time_s > 60.
- `reingest_1_file` — after the above, mutate 20 random files and
  re-run the incremental pipeline per file. Fails if p95 > 2000ms.
- `query-p95` — 100× each of `search_code`, `find_symbol`,
  `find_dependencies`. Fails if any scenario's p95 > 200ms. Skips
  with a warning if Wave 3 L12–L14 query modules are not yet present.

All benchmarks write to `os.tmpdir()` and clean up after. No network —
`MockEmbedder` is used so the numbers don't move with OpenAI latency.
