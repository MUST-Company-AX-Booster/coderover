/**
 * Phase 10 A5 — test fixtures + in-memory TypeORM repository shim.
 *
 * CitationsService (the real one) takes three `Repository<T>` collaborators
 * and issues `find({ where })` / `In(...)` / `Not(In(...))` queries. We
 * don't want to pull pg-mem in just to run those filters, so this module
 * implements the subset of Repository<T> that CitationsService actually
 * touches, with the same semantics for `In`/`Not`.
 *
 * Scope of the shim: this is NOT a general TypeORM mock — only the exact
 * methods the services under test call. If a spec adds a new service and
 * it uses a method not covered here, add it; do not try to be generic.
 */

import { randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';
import type { ConfidenceTag } from '../../../../coderover-api/src/entities/rag-citation.entity';
import type { JwtService } from '@nestjs/jwt';
import type { TokenRevocationService } from '../../../../coderover-api/src/auth/token-revocation.service';
import type { RevokedToken } from '../../../../coderover-api/src/entities/revoked-token.entity';

// ────────────────────────────────────────────────────────────────────────────
// InMemoryRepo — the TypeORM Repository<T> subset services rely on
// ────────────────────────────────────────────────────────────────────────────

type AnyRec = Record<string, any>;

/**
 * Match a `where` clause against a row. Supports:
 *   - scalar equality:   `where: { orgId: 'org-1' }`
 *   - `In([...])`:       `where: { id: In([...]) }`
 *   - `Not(In([...]))`:  `where: { id: Not(In([...])) }`
 *
 * Anything more exotic falls through to a strict-equality check, which
 * mirrors a missing-column: if the service passes a key we haven't
 * implemented, the mock returns false and the spec will flag it.
 */
function matchesWhere(row: AnyRec, where: AnyRec): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (expected instanceof FindOperator) {
      const op = expected as FindOperator<unknown>;
      if (op.type === 'in') {
        const list = op.value as unknown[];
        if (!Array.isArray(list) || !list.includes(row[key])) return false;
      } else if (op.type === 'not') {
        const inner = op.value as FindOperator<unknown> | unknown;
        if (inner instanceof FindOperator) {
          if (inner.type === 'in') {
            const list = inner.value as unknown[];
            if (Array.isArray(list) && list.includes(row[key])) return false;
          } else {
            // Unsupported nested op — fall through defensively.
            return false;
          }
        } else if (row[key] === inner) {
          return false;
        }
      } else {
        // Unknown operator — unsupported, return false to surface early.
        return false;
      }
    } else if (row[key] !== expected) {
      return false;
    }
  }
  return true;
}

export interface InMemoryFindOptions {
  where?: AnyRec | AnyRec[];
  order?: Record<string, 'ASC' | 'DESC' | 1 | -1>;
  take?: number;
  skip?: number;
  select?: string[];
}

/**
 * Minimal Repository<T> substitute.
 *
 * Rows are stored keyed by `id`; callers set `.id` explicitly (we don't
 * try to infer primary keys). `save()` upserts on id. `create(partial)`
 * mirrors TypeORM's: shallow-copy, no side effect. `createQueryBuilder`
 * is implemented only to the extent ConfidenceRetagService uses it —
 * the audit scenario (confidence.spec.ts) builds on top of this.
 */
export class InMemoryRepo<T extends AnyRec = AnyRec> {
  readonly rows = new Map<string, T>();

  /** Raw insert without merge semantics — fills an id when missing. */
  seed(row: T): T {
    const rec = row as AnyRec;
    if (!rec.id) rec.id = randomUUID();
    this.rows.set(rec.id as string, row);
    return row;
  }

  async find(options: InMemoryFindOptions = {}): Promise<T[]> {
    let result = Array.from(this.rows.values());
    if (options.where) {
      const clauses = Array.isArray(options.where) ? options.where : [options.where];
      result = result.filter((row) => clauses.some((w) => matchesWhere(row, w)));
    }
    if (options.order) {
      const entries = Object.entries(options.order);
      result = [...result].sort((a, b) => {
        for (const [key, dir] of entries) {
          const av = (a as AnyRec)[key];
          const bv = (b as AnyRec)[key];
          const direction =
            dir === 'ASC' || dir === 1 ? 1 : dir === 'DESC' || dir === -1 ? -1 : 1;
          if (av === bv) continue;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (av < bv) return -1 * direction;
          if (av > bv) return 1 * direction;
        }
        return 0;
      });
    }
    if (typeof options.skip === 'number') result = result.slice(options.skip);
    if (typeof options.take === 'number') result = result.slice(0, options.take);
    if (options.select) {
      const keys = options.select;
      result = result.map((row) => {
        const out: AnyRec = {};
        for (const k of keys) out[k] = (row as AnyRec)[k];
        // Citation.filePath is needed by the similar-citation reducer even
        // when `select` doesn't include it, but callers that ask for a
        // narrow select accept the projection. Tests don't exercise this
        // edge case.
        return out as T;
      });
    }
    return result;
  }

  async findOne(options: InMemoryFindOptions): Promise<T | null> {
    const list = await this.find({ ...options, take: 1 });
    return list[0] ?? null;
  }

  create(partial: Partial<T>): T {
    return { ...partial } as T;
  }

  async save(entity: T | T[]): Promise<T | T[]> {
    if (Array.isArray(entity)) {
      return entity.map((e) => this.seed(e));
    }
    return this.seed(entity);
  }

  async insert(entity: Partial<T>): Promise<{ identifiers: Partial<T>[] }> {
    const row = this.seed(entity as T);
    return { identifiers: [{ id: (row as AnyRec).id } as unknown as Partial<T>] };
  }

  /**
   * Subset of QueryBuilder covering what ConfidenceRetagService uses:
   * `.orderBy().addOrderBy().skip().take().getMany()`. Chains through
   * `find()` under the hood so the semantics match.
   */
  createQueryBuilder(_alias: string = 't'): InMemoryQueryBuilder<T> {
    return new InMemoryQueryBuilder<T>(this);
  }
}

export class InMemoryQueryBuilder<T extends AnyRec> {
  private readonly orders: Array<[string, 'ASC' | 'DESC']> = [];
  private skipN = 0;
  private takeN = 1_000_000;
  private whereClauses: AnyRec[] = [];

  constructor(private readonly repo: InMemoryRepo<T>) {}

  private col(expr: string): string {
    // Accept `'alias.col_name'` → `camelCase`. Good enough for our services.
    const bare = expr.includes('.') ? expr.split('.').pop()! : expr;
    return bare.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  where(expr: string, _params: AnyRec = {}): this {
    // We only honor `where('col = :val', { val })` for scalar equality in
    // the audit path, which is all the services use today.
    const match = expr.match(/^[\w.]+\s*=\s*:(\w+)$/);
    if (match && _params[match[1]] !== undefined) {
      const col = this.col(expr.split('=')[0].trim());
      this.whereClauses.push({ [col]: _params[match[1]] });
    }
    return this;
  }

  andWhere(expr: string, params: AnyRec = {}): this {
    // Degrade non-equality clauses (IS NULL, > now()) to no-ops — the
    // audit-test DB is small enough that extra rows returned are harmless.
    return this.where(expr, params);
  }

  orderBy(expr: string, dir: 'ASC' | 'DESC' = 'ASC'): this {
    this.orders.length = 0;
    this.orders.push([this.col(expr), dir]);
    return this;
  }

  addOrderBy(expr: string, dir: 'ASC' | 'DESC' = 'ASC'): this {
    this.orders.push([this.col(expr), dir]);
    return this;
  }

  skip(n: number): this {
    this.skipN = n;
    return this;
  }

  take(n: number): this {
    this.takeN = n;
    return this;
  }

  async getMany(): Promise<T[]> {
    const rows = await this.repo.find({
      where: this.whereClauses.length > 0 ? this.whereClauses : undefined,
      order: Object.fromEntries(this.orders),
      skip: this.skipN,
      take: this.takeN,
    });
    return rows;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Canned MCP service + tool catalog
// ────────────────────────────────────────────────────────────────────────────

/** The 4 external tool names A2 commits to exposing. */
export const CANONICAL_MCP_TOOLS = [
  'search_codebase',
  'find_symbol',
  'find_dependencies',
  'get_file',
] as const;

export type ToolResolver = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/**
 * Stand-in for `McpService` that exposes the 4 canonical tools and lets
 * tests override per-tool results. Matches the subset of the real
 * interface the MCP controllers use.
 */
export class CannedMcpService {
  private resolvers = new Map<string, ToolResolver>();

  getTools(): Array<{
    name: string;
    description: string;
    parameters: Array<{
      name: string;
      type: string;
      description: string;
      required?: boolean;
    }>;
  }> {
    return [
      {
        name: 'search_codebase',
        description: 'Hybrid search across indexed code',
        parameters: [
          {
            name: 'query',
            type: 'string',
            description: 'Search query',
            required: true,
          },
        ],
      },
      {
        name: 'find_symbol',
        description: 'Locate a symbol by name',
        parameters: [
          { name: 'symbolName', type: 'string', description: 'Name', required: true },
        ],
      },
      {
        name: 'find_dependencies',
        description: 'List inbound/outbound dependencies',
        parameters: [
          { name: 'target', type: 'string', description: 'Target', required: true },
        ],
      },
      {
        name: 'get_file',
        description: 'Read file contents',
        parameters: [
          { name: 'path', type: 'string', description: 'Path', required: true },
        ],
      },
    ];
  }

  getToolCatalog() {
    return this.getTools();
  }

  getExecutionHistory() {
    return [];
  }

  /** Override the resolver for a tool in a test. */
  onTool(name: string, resolver: ToolResolver): void {
    this.resolvers.set(name, resolver);
  }

  reset(): void {
    this.resolvers.clear();
  }

  async executeTool(toolName: string, args: Record<string, unknown>) {
    const resolver = this.resolvers.get(toolName);
    if (!resolver) {
      // Default: echo + a tiny result payload w/ a confidence field so
      // the tool-dispatch spec can assert end-to-end propagation even
      // without an explicit resolver override.
      return {
        toolName,
        args,
        durationMs: 1,
        result: {
          tool: toolName,
          args,
          results: [
            {
              summary: `stub-${toolName}`,
              confidence: 'INFERRED',
              confidence_score: 0.6,
            },
          ],
        },
      };
    }
    const raw = await resolver(args);
    return {
      toolName,
      args,
      durationMs: 1,
      result: raw,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Auth / other stubs
// ────────────────────────────────────────────────────────────────────────────

export class StubOAuthStateService {
  issue(_purpose: string): string {
    return 'stub-state';
  }
  consume(_state: string) {
    return null;
  }
}

export function createStubAdminConfigService() {
  return {
    getSettingString: async (_key: string) => '',
    getSetting: async (_key: string) => null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// User / token minting helpers for specs
// ────────────────────────────────────────────────────────────────────────────

export interface TestUser {
  userId: string;
  orgId: string;
  email: string;
}

export function createTestUser(orgId = 'test-org-uuid-1'): TestUser {
  return {
    userId: randomUUID(),
    orgId,
    email: `user-${Math.random().toString(36).slice(2, 8)}@example.test`,
  };
}

/**
 * Mint a realistic MCP JWT using the backend's own JwtService. The token
 * carries scope + kind + jti matching what TokenRevocationService.issue
 * would produce in production, including the audit row insert so
 * `isRevoked` can look it up.
 */
export async function issueMcpToken(
  deps: {
    tokenRevocation: TokenRevocationService;
    revokedTokensStore: InMemoryRepo<RevokedToken>;
  },
  user: TestUser,
  scope: string[],
  opts: { expiresInDays?: number } = {},
): Promise<{ token: string; id: string }> {
  const { token, id } = await deps.tokenRevocation.issue({
    userId: user.userId,
    orgId: user.orgId,
    email: user.email,
    role: 'admin' as any,
    scope,
    kind: 'mcp',
    expiresInDays: opts.expiresInDays ?? 30,
  });
  // Double-check the audit row is present (it should be — issue() writes
  // before signing) so tests don't mistakenly pass against a never-written
  // token.
  if (!deps.revokedTokensStore.rows.has(id)) {
    throw new Error(`issueMcpToken: revoked_tokens row ${id} missing after issue()`);
  }
  return { token, id };
}

/**
 * Mint a *forged* token with a jti that has no revoked_tokens row. The
 * revocation guard treats "unknown jti" as revoked so these must 401.
 */
export function issueForgedMcpToken(
  jwtService: JwtService,
  user: TestUser,
  scope: string[],
): string {
  return jwtService.sign(
    {
      sub: user.userId,
      email: user.email,
      role: 'admin',
      roles: ['admin'],
      userId: user.userId,
      orgId: user.orgId,
      scope,
      kind: 'mcp',
    },
    { jwtid: randomUUID(), expiresIn: '1h' },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Row builders — kept tiny and schema-exact
// ────────────────────────────────────────────────────────────────────────────

export interface SeedCitationInput {
  orgId: string;
  chatMessageId?: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  similarity?: number;
  tag: ConfidenceTag;
  score?: number | null;
  producer?: string;
  evidenceRef?: unknown;
}

export function buildCitation(input: SeedCitationInput): Record<string, any> {
  return {
    id: randomUUID(),
    chatMessageId: input.chatMessageId ?? randomUUID(),
    orgId: input.orgId,
    filePath: input.filePath,
    lineStart: input.lineStart ?? 1,
    lineEnd: input.lineEnd ?? 10,
    similarity: input.similarity ?? 0.8,
    confidence: input.tag,
    confidenceScore: input.score ?? null,
    evidenceRef: input.evidenceRef ?? null,
    producer: input.producer ?? 'hybrid-search',
    createdAt: new Date(),
  };
}

export interface SeedFindingInput {
  orgId: string;
  prReviewId?: string;
  file: string;
  line?: number;
  tag: ConfidenceTag;
  score?: number | null;
  producer?: string;
  evidenceRef?: unknown;
}

export function buildFinding(input: SeedFindingInput): Record<string, any> {
  return {
    id: randomUUID(),
    prReviewId: input.prReviewId ?? randomUUID(),
    orgId: input.orgId,
    file: input.file,
    line: input.line ?? 1,
    title: 'Test finding',
    body: 'Seeded via A5 integration fixture',
    severity: 'medium',
    category: 'correctness',
    confidence: input.tag,
    confidenceScore: input.score ?? null,
    evidenceRef: input.evidenceRef ?? null,
    producer: input.producer ?? 'pr-review:deterministic',
    createdAt: new Date(),
  };
}

export interface SeedEdgeAuditInput {
  edgeId: string;
  relationKind?: string;
  producer?: string;
  /**
   * The entity column is `ConfidenceTag` (the user-visible classification),
   * not the raw `ProducerKind` — retag rows carry the *already-classified*
   * tag, which is what ConfidenceRetagService reads off.
   */
  producerKind: ConfidenceTag;
  producerConfidence?: number | null;
  orgId?: string;
  evidenceRef?: unknown;
}

export function buildEdgeAudit(input: SeedEdgeAuditInput): Record<string, any> {
  return {
    id: randomUUID(),
    edgeId: input.edgeId,
    relationKind: input.relationKind ?? 'CALLS',
    producer: input.producer ?? 'ast:graph-sync',
    producerKind: input.producerKind,
    producerConfidence: input.producerConfidence ?? null,
    orgId: input.orgId ?? null,
    evidenceRef: input.evidenceRef ?? null,
    createdAt: new Date(),
  };
}
