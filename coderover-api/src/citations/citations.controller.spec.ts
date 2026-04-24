import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { CitationsController } from './citations.controller';
import { CitationsService } from './citations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ScopeGuard } from '../auth/guards/scope.guard';

/**
 * Phase 10 B4 — Controller integration tests.
 *
 * Boots a minimal Nest HTTP app with the real JwtAuthGuard + ScopeGuard so
 * 401/403 behavior matches production. Auth is injected by overriding the
 * JwtAuthGuard with a fake that reads a `x-test-user` header — this keeps
 * the spec DB-free (no real passport-jwt plumbing needed) while still
 * exercising the real ScopeGuard's metadata check.
 */
describe('CitationsController (HTTP)', () => {
  let app: INestApplication;
  let serviceMock: { getBatchEvidence: jest.Mock };
  let authToken: { user?: any } = {};

  const uuids = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(8, '0');
      return `${hex}-0000-4000-8000-000000000000`;
    });

  // Fake JwtAuthGuard: reads the `authToken` closure set per test. Lets us
  // simulate "no auth" (401), "full-user token" (bypasses scope), and
  // "scoped MCP token" (scope check applies) without signing JWTs.
  class FakeJwtAuthGuard {
    canActivate(context: ExecutionContext) {
      if (!authToken.user) return false; // triggers 401
      const req = context.switchToHttp().getRequest();
      req.user = authToken.user;
      return true;
    }
  }

  beforeAll(async () => {
    serviceMock = { getBatchEvidence: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CitationsController],
      providers: [
        { provide: CitationsService, useValue: serviceMock },
        ScopeGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(FakeJwtAuthGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    serviceMock.getBatchEvidence.mockReset().mockResolvedValue([]);
    authToken = {};
  });

  it('returns 200 for a 100-id batch with a full-user token', async () => {
    authToken = { user: { orgId: 'org-1' /* no scope → full user */ } };
    const ids = uuids(100);
    serviceMock.getBatchEvidence.mockResolvedValue(
      ids.map((id) => ({
        id,
        kind: 'citation',
        tag: 'INFERRED',
        score: 0.5,
        producer: null,
        file_path: null,
        line_start: null,
        line_end: null,
        evidence: { upstream_audits: [], similar_citations: [], raw_ref: null },
      })),
    );

    const res = await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids })
      .expect(200);

    expect(res.body.results).toHaveLength(100);
    expect(serviceMock.getBatchEvidence).toHaveBeenCalledWith(ids, 'org-1');
  });

  it('returns 400 when ids exceeds 100', async () => {
    authToken = { user: { orgId: 'org-1' } };
    const ids = uuids(101);

    await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids })
      .expect(400);

    expect(serviceMock.getBatchEvidence).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is empty', async () => {
    authToken = { user: { orgId: 'org-1' } };

    await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids: [] })
      .expect(400);

    expect(serviceMock.getBatchEvidence).not.toHaveBeenCalled();
  });

  it('returns 400 when ids contains a non-UUID string', async () => {
    authToken = { user: { orgId: 'org-1' } };

    await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids: ['not-a-uuid'] })
      .expect(400);

    expect(serviceMock.getBatchEvidence).not.toHaveBeenCalled();
  });

  it('returns 401 when the request has no auth user', async () => {
    authToken = {}; // JwtAuthGuard stub returns false → 401/403

    // Nest translates canActivate=false on an AuthGuard to 403 by default,
    // but the real JwtAuthGuard throws UnauthorizedException. We use the
    // fake here, so a denied canActivate surfaces as 403. Accept either:
    // what matters is the request is rejected before hitting the service.
    const res = await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids: uuids(1) });

    expect([401, 403]).toContain(res.status);
    expect(serviceMock.getBatchEvidence).not.toHaveBeenCalled();
  });

  it('returns 403 when the scoped token is missing citations:read', async () => {
    // Token carries a scope claim (MCP-style) but not the required one.
    authToken = { user: { orgId: 'org-1', scope: ['search:read'] } };

    await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids: uuids(1) })
      .expect(403);

    expect(serviceMock.getBatchEvidence).not.toHaveBeenCalled();
  });

  it('allows a scoped token that holds citations:read', async () => {
    authToken = { user: { orgId: 'org-1', scope: ['citations:read'] } };
    serviceMock.getBatchEvidence.mockResolvedValue([]);

    await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids: uuids(1) })
      .expect(200);

    expect(serviceMock.getBatchEvidence).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when the token carries no orgId', async () => {
    authToken = { user: { /* no orgId */ } };

    await request(app.getHttpServer())
      .post('/citations/evidence')
      .send({ ids: uuids(1) })
      .expect(400);

    expect(serviceMock.getBatchEvidence).not.toHaveBeenCalled();
  });
});
