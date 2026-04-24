# @coderover/mcp-integration

Phase 10 A5 — end-to-end integration tests that drive the real
`@coderover/mcp` client transport against a test-mode `coderover-api`
backend.

This package is private and ships no runtime artifact. It exists solely
to give `test:integration` a home.

## What it tests

Five scenarios under `src/scenarios/`:

| Scenario                     | What it exercises                                            |
| ---------------------------- | ------------------------------------------------------------ |
| `auth.spec.ts`               | A4 token lifecycle: issue → use → revoke → 401; forged jti.  |
| `mcp-handshake.spec.ts`      | A1+A2: `initialize`, `tools/list`, capability version gate.  |
| `mcp-tools.spec.ts`          | A2: `search_code` / `find_symbol` / `find_dependencies` RPC. |
| `citations-evidence.spec.ts` | B4: batch evidence, cross-org not-found, similar-citations.  |
| `confidence.spec.ts`         | B1/B2/C2: tagger policy, retag job, edge-confidence migration. |

## How to run locally

```
# One-time setup — symlink node_modules from the API package so tsc + jest
# resolve deps without a duplicate install.
cd packages/mcp-integration
ln -sf ../../coderover-api/node_modules node_modules

# Type-check
./node_modules/.bin/tsc --noEmit

# Run the suite
./node_modules/.bin/jest --no-coverage
```

From the API package you can alias this with:

```
cd coderover-api
npm run test:integration
```

### Running against real infrastructure (optional)

The default mode uses in-memory TypeORM and a recording Memgraph mock —
no Postgres / Memgraph / Redis required. To upgrade individual scenarios
to real services, set the corresponding env var before invoking jest:

```
DATABASE_URL=postgres://…   # honored by probePostgres()
MEMGRAPH_URI=bolt://…       # honored by probeMemgraph()
REDIS_URL=redis://…         # honored by probeRedis()
```

The probes are documented in `src/setup/infra-probe.ts`. Today all five
scenarios run fully mocked; the probes are scaffolding for a future real-
backend CI job without breaking the zero-infra path.

A matching `docker-compose` snippet for the upgrade path:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: test
    ports: ["5432:5432"]
  memgraph:
    image: memgraph/memgraph
    ports: ["7687:7687"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
```

## What skips if infra is missing

Today: nothing. The suite is built to pass end-to-end on a machine with
only Node + the test backend's node_modules.

If you wire a scenario to real Postgres/Memgraph/Redis later and the
infra isn't present, follow this pattern in the affected spec:

```ts
import { probePostgres, logSkip } from '../setup/infra-probe';

const pg = probePostgres();
if (!pg.available) logSkip('my-scenario', pg.reason!);

(pg.available ? describe : describe.skip)('my-scenario', () => { ... });
```

Never let an infra gap fail the suite — skip cleanly with a log line.

## Design notes

- **Targeted mini-module, not `AppModule`.** Booting the full NestJS app
  pulls in OpenAI, Neo4j driver, Redis clients, Bull queue processors,
  etc. The test backend wires only the controllers we test end-to-end
  (Citations, MCP protocol, MCP REST) and provides in-memory stubs for
  every repository/service they transitively need. See the header
  comment in `src/setup/test-backend.ts` for the full trade-off.
- **Real MCP client code under test.** The handshake + tool-dispatch
  specs import directly from `packages/mcp/src/` — we're testing the
  production transport, not a stand-in.
- **Real guards under test.** `ScopeGuard` and `JwtAuthGuard` / Passport
  JWT strategy are the production classes. Only data-layer services are
  swapped for in-memory doubles.
