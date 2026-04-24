/**
 * Phase 10 A5 — test-backend bootstrap.
 *
 * Trade-off (see A5 plan): rather than booting the full `AppModule` (which
 * demands Postgres + Redis + Memgraph via TypeORM + BullMQ + neo4j-driver
 * at module-init time), we wire a **targeted mini-module** here that imports
 * only the controllers + services we actually drive end-to-end:
 *
 *   - AuthModule-equivalent:        JwtModule, JwtStrategy, ScopeGuard,
 *                                   TokenRevocationService (w/ in-memory
 *                                   revoked_tokens store).
 *   - CitationsController + Service with an in-memory RagCitation /
 *     PrReviewFinding / EdgeProducerAudit store keyed by orgId.
 *   - McpProtocolController + McpController with a stub McpService that
 *     resolves tool-call fixtures inline.
 *
 * Why not pg-mem / the full AppModule?
 *   - Booting `AppModule.compile()` needs real TypeORM datasources, OpenAI
 *     keys, Memgraph bolt URI, Redis, Bull queue processors — every one
 *     of which fails a CI job that doesn't provision infrastructure.
 *   - A5 is an integration test of the **Phase-10-gap HTTP contract**
 *     (A1/A2/A4/B4), not a repo-wide smoke test. Exercising the real
 *     guards + HTTP stack on the endpoints we care about gets us 95% of
 *     the coverage at 5% of the operational cost.
 *
 * What's real:
 *   - `JwtStrategy` (passport-jwt) validates signed JWTs end-to-end.
 *   - `ScopeGuard` enforces scope metadata exactly like production.
 *   - `TokenRevocationService` with in-memory Repository shim exercises
 *     the revoke → cache-TTL → 401 handoff.
 *   - Nest HTTP pipeline (ValidationPipe etc.) runs as in production.
 *
 * What's mocked:
 *   - TypeORM repositories for RagCitation, PrReviewFinding,
 *     EdgeProducerAudit, RevokedToken — replaced with in-memory Map-backed
 *     stubs satisfying the subset of Repository<T> methods the services
 *     actually call.
 *   - McpService — returns canned tool results so we can exercise the
 *     MCP JSON-RPC dispatcher without pulling in SearchService, graph,
 *     Redis, etc.
 *   - MemgraphService — recording mock for the confidence-retag scenario.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { AddressInfo } from 'node:net';

import { CitationsController } from '../../../../coderover-api/src/citations/citations.controller';
import { CitationsService } from '../../../../coderover-api/src/citations/citations.service';
import { JwtAuthGuard } from '../../../../coderover-api/src/auth/guards/jwt-auth.guard';
import { ScopeGuard } from '../../../../coderover-api/src/auth/guards/scope.guard';
import { JwtStrategy } from '../../../../coderover-api/src/auth/strategies/jwt.strategy';
import { AuthService } from '../../../../coderover-api/src/auth/auth.service';
import { TokenRevocationService } from '../../../../coderover-api/src/auth/token-revocation.service';
import { OAuthStateService } from '../../../../coderover-api/src/auth/oauth-state.service';
import { AdminConfigService } from '../../../../coderover-api/src/admin/admin-config.service';

import { RagCitation } from '../../../../coderover-api/src/entities/rag-citation.entity';
import { PrReviewFinding } from '../../../../coderover-api/src/entities/pr-review-finding.entity';
import { EdgeProducerAudit } from '../../../../coderover-api/src/entities/edge-producer-audit.entity';
import { RevokedToken } from '../../../../coderover-api/src/entities/revoked-token.entity';
import { GithubConnection } from '../../../../coderover-api/src/entities/github-connection.entity';
import { User } from '../../../../coderover-api/src/entities/user.entity';
import { OrgMembership } from '../../../../coderover-api/src/entities/org-membership.entity';

import { McpProtocolController } from '../../../../coderover-api/src/mcp/mcp-protocol.controller';
import { McpController } from '../../../../coderover-api/src/mcp/mcp.controller';
import { McpService } from '../../../../coderover-api/src/mcp/mcp.service';

import {
  InMemoryRepo,
  CannedMcpService,
  createStubAdminConfigService,
  StubOAuthStateService,
} from './fixtures';

/** Minimal shape the test harness exposes to specs. */
export interface TestBackend {
  baseUrl: string;
  jwtService: JwtService;
  tokenRevocation: TokenRevocationService;
  stores: {
    ragCitations: InMemoryRepo<RagCitation>;
    prFindings: InMemoryRepo<PrReviewFinding>;
    edgeAudits: InMemoryRepo<EdgeProducerAudit>;
    revokedTokens: InMemoryRepo<RevokedToken>;
  };
  mcp: CannedMcpService;
  stop(): Promise<void>;
}

export interface TestBackendOptions {
  /** Override the JWT signing secret. Default: fixed test secret. */
  jwtSecret?: string;
}

const DEFAULT_JWT_SECRET = 'a5-integration-test-secret-do-not-use-in-prod';

/**
 * Boot the test backend on a random port. Returns handles the specs need
 * to mint JWTs, seed rows, and tear down cleanly.
 */
export async function startTestBackend(
  opts: TestBackendOptions = {},
): Promise<TestBackend> {
  const jwtSecret = opts.jwtSecret ?? DEFAULT_JWT_SECRET;
  process.env.JWT_SECRET = jwtSecret;

  const ragCitations = new InMemoryRepo<RagCitation>();
  const prFindings = new InMemoryRepo<PrReviewFinding>();
  const edgeAudits = new InMemoryRepo<EdgeProducerAudit>();
  const revokedTokens = new InMemoryRepo<RevokedToken>();
  const mcp = new CannedMcpService();

  const moduleRef = await Test.createTestingModule({
    imports: [
      // ConfigModule in isDynamicModule-register mode so JwtStrategy's
      // `configService.get('JWT_SECRET')` finds the secret we set above
      // via process.env. Without this, JwtStrategy constructs with an
      // undefined secret and every token fails to verify.
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
      PassportModule.register({ defaultStrategy: 'jwt' }),
      JwtModule.register({
        secret: jwtSecret,
        signOptions: { expiresIn: '1h' },
      }),
    ],
    controllers: [CitationsController, McpProtocolController, McpController],
    providers: [
      Reflector,
      JwtAuthGuard,
      ScopeGuard,
      JwtStrategy,
      TokenRevocationService,
      // AuthService is a dependency of JwtStrategy — stub its validateUser
      // to pass the payload through untouched. We never exercise its
      // GitHub-OAuth branches in A5.
      {
        provide: AuthService,
        useValue: {
          validateUser: async (payload: unknown) => payload,
        },
      },
      // OAuthStateService + AdminConfigService are transitive deps of
      // AuthService in the real module graph. Provide inert stubs so the
      // Nest DI resolver is happy even though we never call them.
      { provide: OAuthStateService, useClass: StubOAuthStateService },
      { provide: AdminConfigService, useValue: createStubAdminConfigService() },

      // Real CitationsService, with in-memory repos under the hood.
      CitationsService,
      { provide: getRepositoryToken(RagCitation), useValue: ragCitations },
      { provide: getRepositoryToken(PrReviewFinding), useValue: prFindings },
      { provide: getRepositoryToken(EdgeProducerAudit), useValue: edgeAudits },
      { provide: getRepositoryToken(RevokedToken), useValue: revokedTokens },

      // Unused but referenced for DI completeness if AuthModule imports
      // ever pull these in. Kept as empty repos — never touched.
      { provide: getRepositoryToken(GithubConnection), useValue: new InMemoryRepo() },
      { provide: getRepositoryToken(User), useValue: new InMemoryRepo() },
      { provide: getRepositoryToken(OrgMembership), useValue: new InMemoryRepo() },

      // MCP: swap the real service for a canned one so tool fixtures are
      // stable and don't require SearchService / Memgraph / OpenAI.
      { provide: McpService, useValue: mcp },
    ],
  }).compile();

  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  await app.listen(0);
  const server = app.getHttpServer();
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    jwtService: moduleRef.get(JwtService),
    tokenRevocation: moduleRef.get(TokenRevocationService),
    stores: { ragCitations, prFindings, edgeAudits, revokedTokens },
    mcp,
    async stop() {
      await app.close();
    },
  };
}
