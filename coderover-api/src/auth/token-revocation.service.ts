import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { RevokedToken, TokenKind } from '../entities/revoked-token.entity';
import { JwtPayload } from './auth.service';
import { Role } from './roles.enum';

/**
 * Phase 10 A4 — MCP + revocable JWT issuance.
 *
 * The row in `revoked_tokens` is the source of truth. The JWT carries
 * everything the guard needs (sub, orgId, scope, kind, jti), but the
 * `jti → revoked_at` lookup is what actually decides "is this token
 * still live right now?".
 *
 * We cache `isRevoked` answers in memory for 30s because every authed
 * request hits it, and the row state only changes when a user clicks
 * "revoke" in the admin UI. 30s is the blast radius: a revoke call takes
 * effect within 30s everywhere, which matches the product promise.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);

  /** Cache TTL for isRevoked lookups. Keep short — see module docstring. */
  private static readonly CACHE_TTL_MS = 30_000;

  /** Default expiry for issued tokens when the caller doesn't specify. */
  private static readonly DEFAULT_EXPIRY_DAYS = 90;

  /** Upper bound on expiry. A minted MCP token should not outlive a year. */
  private static readonly MAX_EXPIRY_DAYS = 365;

  /**
   * Map keyed by `jti`. Value is `{ revokedAt, cachedAt }`:
   *   revokedAt === null  → token is active
   *   revokedAt instanceof Date → token is revoked (actionable)
   *   revokedAt === 'missing' → jti has no row; guard should treat as invalid
   */
  private readonly cache = new Map<
    string,
    { revokedAt: Date | null | 'missing'; cachedAt: number }
  >();

  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(RevokedToken)
    private readonly revokedTokenRepo: Repository<RevokedToken>,
  ) {}

  /**
   * Mint a new scoped JWT, record the row, return the signed token + id.
   *
   * Writes to Postgres BEFORE signing the JWT so a partial failure leaves
   * no orphan tokens (a signed-but-unrecorded JWT would be indistinguishable
   * from a pre-A4 legacy token and would never be revokable).
   */
  async issue(params: {
    userId: string;
    orgId: string;
    email: string;
    role: Role;
    scope: string[];
    kind: TokenKind;
    expiresInDays?: number;
    label?: string | null;
  }): Promise<{ token: string; id: string; expiresAt: Date }> {
    const scope = this.sanitizeScope(params.scope);
    const days = this.sanitizeExpiryDays(params.expiresInDays);

    if (params.kind !== 'user' && params.kind !== 'mcp') {
      throw new BadRequestException(`Invalid token kind: ${params.kind}`);
    }

    const id = uuid();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // 1. Insert the audit row FIRST. If this throws we haven't signed
    //    anything and the caller gets a clean error.
    await this.revokedTokenRepo.save(
      this.revokedTokenRepo.create({
        id,
        orgId: params.orgId,
        userId: params.userId,
        kind: params.kind,
        scope,
        label: params.label ?? null,
        expiresAt,
        revokedAt: null,
      }),
    );

    // 2. Sign the JWT with a matching jti + exp. Passport's jwt strategy
    //    will auto-reject on exp; we don't duplicate that check.
    const payload: JwtPayload = {
      sub: params.userId,
      email: params.email,
      role: params.role,
      roles: [params.role],
      userId: params.userId,
      orgId: params.orgId,
      scope,
      kind: params.kind,
    };
    const token = this.jwtService.sign(payload, {
      jwtid: id,
      expiresIn: `${days}d`,
    });

    this.logger.log(
      `Issued ${params.kind} token id=${id.slice(0, 8)}... user=${params.userId} scope=[${scope.join(', ')}] ttl=${days}d`,
    );

    return { token, id, expiresAt };
  }

  /**
   * Mark a token revoked. Only the original issuer may revoke their own
   * tokens — the admin-wide revoke path lives in the admin module and
   * would call `revokedTokenRepo` directly with its own authorization.
   */
  async revoke(tokenId: string, userId: string): Promise<RevokedToken> {
    const row = await this.revokedTokenRepo.findOne({ where: { id: tokenId } });
    if (!row) {
      throw new NotFoundException('Token not found');
    }
    if (row.userId !== userId) {
      // Returning NotFound (not Forbidden) so we don't expose token-id
      // existence to a caller who can't act on it.
      throw new NotFoundException('Token not found');
    }
    if (row.revokedAt) {
      // Idempotent: re-revoking is a no-op on the row but we still bust
      // the cache so the caller's assumption "it's revoked now" holds.
      this.bustCache(tokenId);
      return row;
    }
    row.revokedAt = new Date();
    const saved = await this.revokedTokenRepo.save(row);
    this.bustCache(tokenId);
    this.logger.log(`Revoked token id=${tokenId.slice(0, 8)}... user=${userId}`);
    return saved;
  }

  /**
   * The hot path — called on every authed request that carries a `jti`.
   * Returns `true` if the token is revoked OR unknown (an unknown jti
   * means someone forged the claim; treat as revoked).
   *
   * Cache semantics:
   *   - Positive hits (revoked) stay cached so repeated requests fail fast.
   *   - Negative hits (active) stay cached for TTL_MS; a `revoke()` call
   *     invalidates via `bustCache`.
   */
  async isRevoked(tokenId: string): Promise<boolean> {
    if (!tokenId) return false;
    const cached = this.cache.get(tokenId);
    const now = Date.now();
    if (cached && now - cached.cachedAt < TokenRevocationService.CACHE_TTL_MS) {
      if (cached.revokedAt === 'missing') return true;
      return cached.revokedAt !== null;
    }

    const row = await this.revokedTokenRepo.findOne({
      where: { id: tokenId },
      select: ['id', 'revokedAt'],
    });

    if (!row) {
      this.cache.set(tokenId, { revokedAt: 'missing', cachedAt: now });
      return true;
    }

    this.cache.set(tokenId, { revokedAt: row.revokedAt, cachedAt: now });
    return row.revokedAt !== null;
  }

  /**
   * List active + recently-revoked tokens for the org. The UI shows both
   * so a user can see their history without a second API call; filtering
   * to active-only is a client concern.
   */
  async listForOrg(orgId: string): Promise<RevokedToken[]> {
    return this.revokedTokenRepo.find({
      where: { orgId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  /**
   * List only active tokens for a user. Used by the per-user settings
   * panel. `expires_at < now()` rows are excluded — expired tokens are
   * already invalid by JWT `exp`, no point showing them as "active".
   */
  async listActiveForUser(userId: string): Promise<RevokedToken[]> {
    return this.revokedTokenRepo
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId })
      .andWhere('t.revoked_at IS NULL')
      .andWhere('t.expires_at > now()')
      .orderBy('t.created_at', 'DESC')
      .getMany();
  }

  /** Test + revoke-path helper. Never call from request code paths. */
  clearCache(): void {
    this.cache.clear();
  }

  private bustCache(tokenId: string): void {
    this.cache.delete(tokenId);
  }

  private sanitizeScope(scope: string[]): string[] {
    if (!Array.isArray(scope)) {
      throw new BadRequestException('scope must be an array of strings');
    }
    const cleaned = scope
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s.length > 0);
    // De-dupe while preserving order.
    return Array.from(new Set(cleaned));
  }

  private sanitizeExpiryDays(expiresInDays?: number): number {
    if (expiresInDays === undefined || expiresInDays === null) {
      return TokenRevocationService.DEFAULT_EXPIRY_DAYS;
    }
    const n = Number(expiresInDays);
    if (!Number.isFinite(n) || n <= 0) {
      throw new BadRequestException('expires_in_days must be a positive integer');
    }
    if (n > TokenRevocationService.MAX_EXPIRY_DAYS) {
      throw new BadRequestException(
        `expires_in_days must be ≤ ${TokenRevocationService.MAX_EXPIRY_DAYS}`,
      );
    }
    return Math.floor(n);
  }

  // Re-export for use by guards/tests that want to align on cache behavior.
  static get CACHE_TTL(): number {
    return TokenRevocationService.CACHE_TTL_MS;
  }
}
