# Phase 10 C5 benchmarks

Manually-run harnesses for the two headline Phase 10 value props.

## Usage

```
# from coderover-api/
npm run bench                   # both
npm run bench:reingest          # ContentCacheService hot-path hit rate
npm run bench:watch             # WatchDaemonService event→processed latency

# type-check only
npx tsc -p benchmarks/tsconfig.json --noEmit

# integrity spec for the harness utilities
npx jest --config jest.config.ts
```

## What's measured

- `reingest_unchanged` — second-ingest hit rate on an unchanged file set. Fails if hit rate < 99% or p95 > 100ms.
- `watch_latency` — event→`stats.processed` wall time (mock backend). Fails if p95 > 1000ms (500ms debounce).
