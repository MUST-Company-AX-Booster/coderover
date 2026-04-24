import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TokenRevocationService } from './token-revocation.service';
import { RevokedToken } from '../entities/revoked-token.entity';
import { Role } from './roles.enum';

/**
 * Phase 10 A4 — Critical-gap test #1: JWT scope rejection + revocation
 * round-trip. These unit tests cover the revocation service; the guard
 * + scope decorator have their own specs.
 *
 * All DB access goes through a mocked Repository so we never touch real
 * Postgres. The cache is in-memory on the service instance, so fake
 * timers give us full control over the 30s TTL.
 */
describe('TokenRevocationService', () => {
  let service: TokenRevocationService;
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let jwt: { sign: jest.Mock };

  const USER_ID = '11111111-1111-1111-1111-111111111111';
  const ORG_ID = '22222222-2222-2222-2222-222222222222';

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn(async (row) => row),
      create: jest.fn((row) => row),
      find: jest.fn(async () => []),
      createQueryBuilder: jest.fn(),
    };
    jwt = { sign: jest.fn(() => 'signed.jwt.token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenRevocationService,
        { provide: JwtService, useValue: jwt },
        { provide: getRepositoryToken(RevokedToken), useValue: repo },
      ],
    }).compile();

    service = module.get(TokenRevocationService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('issue', () => {
    it('writes the audit row before signing the JWT (no orphan tokens)', async () => {
      const callOrder: string[] = [];
      repo.save.mockImplementation(async (row) => {
        callOrder.push('save');
        return row;
      });
      jwt.sign.mockImplementation(() => {
        callOrder.push('sign');
        return 'signed';
      });

      await service.issue({
        userId: USER_ID,
        orgId: ORG_ID,
        email: 'a@b.co',
        role: Role.User,
        scope: ['search:read'],
        kind: 'mcp',
      });

      expect(callOrder).toEqual(['save', 'sign']);
    });

    it('returns a token id that matches the signed JWT jti', async () => {
      const result = await service.issue({
        userId: USER_ID,
        orgId: ORG_ID,
        email: 'a@b.co',
        role: Role.User,
        scope: ['search:read'],
        kind: 'mcp',
      });

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_ID, scope: ['search:read'], kind: 'mcp' }),
        expect.objectContaining({ jwtid: result.id }),
      );
      expect(result.token).toBe('signed.jwt.token');
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('defaults to 90 day expiry when expires_in_days is omitted', async () => {
      const before = Date.now();
      const result = await service.issue({
        userId: USER_ID,
        orgId: ORG_ID,
        email: 'a@b.co',
        role: Role.User,
        scope: [],
        kind: 'mcp',
      });

      const daysUntilExpiry = (result.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
      expect(daysUntilExpiry).toBeGreaterThan(89.99);
      expect(daysUntilExpiry).toBeLessThan(90.01);
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ expiresIn: '90d' }),
      );
    });

    it('rejects expires_in_days > 365', async () => {
      await expect(
        service.issue({
          userId: USER_ID,
          orgId: ORG_ID,
          email: 'a@b.co',
          role: Role.User,
          scope: [],
          kind: 'mcp',
          expiresInDays: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-positive expires_in_days', async () => {
      await expect(
        service.issue({
          userId: USER_ID,
          orgId: ORG_ID,
          email: 'a@b.co',
          role: Role.User,
          scope: [],
          kind: 'mcp',
          expiresInDays: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('de-dupes and trims scope strings', async () => {
      await service.issue({
        userId: USER_ID,
        orgId: ORG_ID,
        email: 'a@b.co',
        role: Role.User,
        scope: ['search:read', ' search:read ', 'graph:read', ''],
        kind: 'mcp',
      });
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ scope: ['search:read', 'graph:read'] }),
        expect.anything(),
      );
    });
  });

  describe('isRevoked + cache', () => {
    function fakeRow(partial: Partial<RevokedToken>): RevokedToken {
      return {
        id: partial.id ?? 'token-1',
        orgId: ORG_ID,
        userId: USER_ID,
        kind: 'mcp',
        scope: [],
        label: null,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: partial.revokedAt ?? null,
        createdAt: new Date(),
      } as RevokedToken;
    }

    it('returns false for an active token and true after revoke', async () => {
      // 1. First isRevoked — DB reports active.
      repo.findOne.mockResolvedValueOnce(fakeRow({ id: 'token-1', revokedAt: null }));
      expect(await service.isRevoked('token-1')).toBe(false);

      // 2. revoke() reads the row, flips revokedAt, saves. bustCache runs.
      repo.findOne.mockResolvedValueOnce(fakeRow({ id: 'token-1', revokedAt: null }));
      await service.revoke('token-1', USER_ID);

      // 3. Next isRevoked call hits the DB again (cache busted) and sees
      //    the persisted revocation.
      repo.findOne.mockResolvedValueOnce(fakeRow({ id: 'token-1', revokedAt: new Date() }));
      expect(await service.isRevoked('token-1')).toBe(true);
    });

    it('treats an unknown jti as revoked (forged claim defense)', async () => {
      repo.findOne.mockResolvedValue(null);
      expect(await service.isRevoked('never-issued')).toBe(true);
    });

    it('caches isRevoked for 30s — N hot calls hit the DB once', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-17T00:00:00Z'));
      repo.findOne.mockResolvedValue(fakeRow({ id: 'hot', revokedAt: null }));

      for (let i = 0; i < 25; i++) {
        expect(await service.isRevoked('hot')).toBe(false);
      }
      expect(repo.findOne).toHaveBeenCalledTimes(1);

      // Fast-forward 29s — still cached.
      jest.setSystemTime(new Date('2026-04-17T00:00:29Z'));
      expect(await service.isRevoked('hot')).toBe(false);
      expect(repo.findOne).toHaveBeenCalledTimes(1);

      // Fast-forward past TTL → DB is consulted again.
      jest.setSystemTime(new Date('2026-04-17T00:00:31Z'));
      expect(await service.isRevoked('hot')).toBe(false);
      expect(repo.findOne).toHaveBeenCalledTimes(2);
    });

    it('revoked state stays true across the cache window', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-17T00:00:00Z'));

      // 1. active
      repo.findOne.mockResolvedValueOnce(fakeRow({ id: 'cwin', revokedAt: null }));
      expect(await service.isRevoked('cwin')).toBe(false);

      // 2. revoke — findOne called inside revoke()
      repo.findOne.mockResolvedValueOnce(fakeRow({ id: 'cwin', revokedAt: null }));
      await service.revoke('cwin', USER_ID);

      // 3. isRevoked immediately after revoke → goes to DB (cache busted)
      //    and returns true from the persisted revokedAt.
      repo.findOne.mockResolvedValueOnce(fakeRow({ id: 'cwin', revokedAt: new Date() }));
      expect(await service.isRevoked('cwin')).toBe(true);

      // 4. Multiple calls within the cache window all return true, and
      //    the total DB hit count across the window is bounded at 1
      //    (from the step-3 refresh). Drop any further Once mocks so a
      //    cache miss would surface as `undefined` and fail loudly.
      const before = repo.findOne.mock.calls.length;
      for (let i = 1; i <= 10; i++) {
        jest.setSystemTime(new Date(Date.UTC(2026, 3, 17, 0, 0, i)));
        expect(await service.isRevoked('cwin')).toBe(true);
      }
      expect(repo.findOne.mock.calls.length).toBe(before);
    });
  });

  describe('revoke', () => {
    it('404s when the token does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.revoke('missing', USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s (not 403) when another user tries to revoke — avoids id-enumeration', async () => {
      repo.findOne.mockResolvedValue({
        id: 't',
        userId: 'other-user',
        revokedAt: null,
      } as any);
      await expect(service.revoke('t', USER_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent when the token is already revoked', async () => {
      const already = {
        id: 't',
        userId: USER_ID,
        revokedAt: new Date('2026-04-16T00:00:00Z'),
      } as any;
      repo.findOne.mockResolvedValue(already);
      const result = await service.revoke('t', USER_ID);
      expect(result.revokedAt).toEqual(already.revokedAt);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('listForOrg', () => {
    it('returns rows ordered by created_at desc, capped at 200', async () => {
      repo.find.mockResolvedValue([
        { id: 'b', createdAt: new Date('2026-04-16') },
        { id: 'a', createdAt: new Date('2026-04-15') },
      ]);
      const rows = await service.listForOrg(ORG_ID);
      expect(rows.length).toBe(2);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: ORG_ID },
          order: { createdAt: 'DESC' },
          take: 200,
        }),
      );
    });
  });
});
