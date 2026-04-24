import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { AuthService, JwtPayload } from '../auth.service';
import { TokenRevocationService } from '../token-revocation.service';
import { Role } from '../roles.enum';

/**
 * Phase 10 A4 — Guard integration. The JwtStrategy.validate() runs on
 * every authed request, so revocation-check behavior here is critical:
 *
 *   - Revoked token (jti + row.revokedAt) → 401.
 *   - Active token (jti + row.revokedAt === null) → pass through to
 *     AuthService.validateUser.
 *   - Legacy token (no jti) → skip revocation check entirely. This is
 *     the backward-compat path; tests guard against accidental removal.
 */
describe('JwtStrategy (A4 revocation check)', () => {
  let strategy: JwtStrategy;
  let authService: { validateUser: jest.Mock };
  let tokenRevocation: { isRevoked: jest.Mock };

  beforeEach(() => {
    authService = {
      validateUser: jest.fn(async (p: JwtPayload) => p),
    };
    tokenRevocation = {
      isRevoked: jest.fn(async () => false),
    };
    const configService = {
      get: jest.fn().mockReturnValue('test-jwt-secret-not-a-real-key'),
    } as unknown as ConfigService;

    strategy = new JwtStrategy(
      configService,
      authService as unknown as AuthService,
      tokenRevocation as unknown as TokenRevocationService,
    );
  });

  const basePayload: JwtPayload = {
    sub: 'user-1',
    email: 'a@b.co',
    role: Role.User,
    roles: [Role.User],
    orgId: 'org-1',
    userId: 'user-1',
  };

  it('passes through a token without a jti (legacy / pre-A4 token)', async () => {
    const payload = { ...basePayload }; // no jti
    const result = await strategy.validate(payload);

    expect(tokenRevocation.isRevoked).not.toHaveBeenCalled();
    expect(authService.validateUser).toHaveBeenCalledWith(payload);
    expect(result).toEqual(payload);
  });

  it('accepts an active token with a jti', async () => {
    tokenRevocation.isRevoked.mockResolvedValue(false);
    const payload: JwtPayload = { ...basePayload, jti: 'live-token', kind: 'mcp' };

    const result = await strategy.validate(payload);

    expect(tokenRevocation.isRevoked).toHaveBeenCalledWith('live-token');
    expect(authService.validateUser).toHaveBeenCalledWith(payload);
    expect(result).toEqual(payload);
  });

  it('rejects a revoked token with 401 (not a silent pass)', async () => {
    tokenRevocation.isRevoked.mockResolvedValue(true);
    const payload: JwtPayload = { ...basePayload, jti: 'dead-token', kind: 'mcp' };

    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.validateUser).not.toHaveBeenCalled();
  });
});
