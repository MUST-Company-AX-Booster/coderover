import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Octokit } from '@octokit/rest';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Role } from './roles.enum';
import { GithubConnection } from '../entities/github-connection.entity';
import { User } from '../entities/user.entity';
import { OrgMembership } from '../entities/org-membership.entity';
import { OAuthStateService } from './oauth-state.service';
import { AdminConfigService } from '../admin/admin-config.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  roles: Role[];
  /** Phase 9: active organization scope for this token. Optional during migration. */
  orgId?: string;
  /** Phase 9: convenience mirror of sub as userId. */
  userId?: string;
  /**
   * Phase 10 A4: capability scopes for MCP-issued tokens
   * (e.g. `['search:read', 'graph:read']`). Absent → full-user token
   * (backward compat with pre-A4 sessions).
   */
  scope?: string[];
  /**
   * Phase 10 A4: token kind. Absent is treated as `'user'` so legacy
   * tokens minted before A4 continue to validate.
   */
  kind?: 'user' | 'mcp';
  /**
   * Phase 10 A4: JWT ID. Present only on tokens issued via
   * `POST /auth/tokens` (the minted-and-revocable path). Absent for all
   * pre-A4 tokens — the guard intentionally skips the revocation lookup
   * when `jti` is missing so we don't break existing sessions.
   */
  jti?: string;
  /** Standard JWT expiration (seconds since epoch). Populated by the signer. */
  exp?: number;
}

export interface GithubLoginResult {
  accessToken: string;
  access_token: string;
  refreshToken: string;
  token_type: string;
  user: {
    id: string;
    email: string;
    role: Role;
    name: string | null;
    githubLogin: string;
    githubId: string;
  };
  org: { id: string; slug: string } | null;
}

/**
 * Unified GitHub OAuth scopes — covers both "log me in" and "list/register
 * my repos" without requiring a second OAuth round-trip. Phase 10
 * (2026-04-16) consolidates the two legacy flows (`/auth/github/*` for
 * login, `/github-integration/*` for repo listing) onto this scope set.
 */
const GITHUB_OAUTH_SCOPE = 'read:user,user:email,repo,read:org,admin:repo_hook';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly oauthStateService: OAuthStateService,
    private readonly adminConfig: AdminConfigService,
    @InjectRepository(GithubConnection)
    private readonly githubConnectionRepository: Repository<GithubConnection>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(OrgMembership)
    private readonly orgMembershipRepository: Repository<OrgMembership>,
  ) {}

  /** Phase 9: idempotently ensure the user is a member of the Default org. */
  private async ensureDefaultMembership(userId: string): Promise<void> {
    try {
      await this.orgMembershipRepository.query(
        `INSERT INTO org_memberships (org_id, user_id, role)
         SELECT id, $1, 'owner' FROM organizations WHERE slug = 'default'
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [userId],
      );
    } catch (err) {
      this.logger.warn(
        `ensureDefaultMembership failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Phase 9: find the user's default org (first membership, preferring 'default' slug). */
  private async defaultOrgIdFor(userId: string): Promise<{ id: string; slug: string } | null> {
    const memberships = await this.orgMembershipRepository.find({
      where: { userId },
      relations: ['organization'],
    });
    if (!memberships.length) return null;
    const preferred = memberships.find((m) => m.organization?.slug === 'default');
    const chosen = preferred ?? memberships[0];
    return { id: chosen.orgId, slug: chosen.organization?.slug ?? 'unknown' };
  }

  /**
   * Legacy email-only token issuance. Retained only for backwards
   * compatibility with callers that pre-date the Phase 9 `generateTokenPair`.
   * New code should go through `loginWithPassword` or `loginWithGitHubCode`.
   */
  async login(
    userId: string,
    email: string,
    role: Role = Role.Admin,
  ): Promise<{ accessToken: string; access_token: string; token_type: string }> {
    const payload: JwtPayload = { sub: userId, email, role, roles: [role] };
    const accessToken = this.jwtService.sign(payload);
    this.logger.log(`Token generated for user ${userId}`);
    return {
      accessToken,
      access_token: accessToken,
      token_type: 'Bearer',
    };
  }

  /** Validate token payload */
  async validateUser(payload: JwtPayload): Promise<JwtPayload> {
    if (!payload.sub) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return payload;
  }

  /**
   * Mint the GitHub OAuth authorize URL with a cryptographically random,
   * server-validated `state` parameter (replacing the legacy predictable
   * `login-${Date.now()}`). Caller embeds the state in the authorize URL;
   * `OAuthStateService.consume` validates + single-uses it on callback.
   */
  async getGitHubLoginUrl(): Promise<{
    authUrl: string;
    state: string;
    callbackUrl: string;
    configured: boolean;
  }> {
    // Phase 10 (2026-04-16): pull OAuth config from SystemSetting DB first
    // so admins can rotate GitHub app credentials from the Settings UI
    // without a restart. Falls back to env via AdminConfigService.
    const clientId = await this.adminConfig.getSettingString('GITHUB_CLIENT_ID');
    const callbackUrl = await this.adminConfig.getSettingString('GITHUB_CALLBACK_URL');
    const state = this.oauthStateService.issue('github-login');

    return {
      authUrl: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${encodeURIComponent(GITHUB_OAUTH_SCOPE)}&state=${encodeURIComponent(state)}`,
      state,
      callbackUrl,
      configured: Boolean(clientId && callbackUrl),
    };
  }

  /**
   * Validate a callback's state parameter in isolation. Returns true if
   * the state matches an issued `github-login` record; false otherwise.
   * Called by the `/auth/github/callback` handler before redirecting the
   * user to the frontend so we don't bounce unauthenticated traffic.
   *
   * Note: `consume` is single-use. The callback handler MUST NOT also
   * call `loginWithGitHubCode` in the same request — that's the
   * frontend's job via `/auth/github/exchange`.
   */
  consumeOAuthState(state: string): boolean {
    const record = this.oauthStateService.consume(state);
    return Boolean(record && record.purpose === 'github-login');
  }

  /**
   * Exchange a GitHub authorization code for app tokens.
   *
   * Called by `POST /auth/github/exchange` (not by the initial redirect
   * handler). This is the method that:
   *
   *   1. Trades the GitHub code for a GitHub access token.
   *   2. Fetches the GitHub user + primary verified email.
   *   3. Upserts a `users` row (linking by email) — never by
   *      email-as-userId like the old code did.
   *   4. Calls `ensureDefaultMembership` so the user has an org.
   *   5. Upserts `github_connections` keyed by `users.id` UUID and stores
   *      refresh token + expiries if GitHub returned them.
   *   6. Issues a real access + refresh token pair with `orgId` in the
   *      JWT claims (fixing the orgId-missing regression).
   */
  async loginWithGitHubCode(code: string): Promise<GithubLoginResult> {
    // Phase 10 (2026-04-16): DB-first config; supports live credential
    // rotation. GITHUB_CLIENT_SECRET is stored encrypted at rest — the
    // resolver decrypts on read.
    const clientId = await this.adminConfig.getSettingString('GITHUB_CLIENT_ID');
    const clientSecret = await this.adminConfig.getSettingString('GITHUB_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new UnauthorizedException('GitHub OAuth is not configured');
    }
    if (!code) {
      throw new BadRequestException('Missing GitHub authorization code');
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenPayload = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenResponse.ok || !tokenPayload.access_token) {
      throw new UnauthorizedException(
        tokenPayload.error_description || tokenPayload.error || 'GitHub token exchange failed',
      );
    }

    const octokit = new Octokit({ auth: tokenPayload.access_token });
    const githubUser = await octokit.users.getAuthenticated();
    const emails = await octokit.users.listEmailsForAuthenticatedUser();
    const primaryEmail =
      emails.data.find((item) => item.primary && item.verified)?.email ||
      emails.data.find((item) => item.verified)?.email ||
      emails.data.find((item) => item.primary)?.email ||
      `${githubUser.data.login}@users.noreply.github.com`;

    // Upsert users row by email (never by github_id alone — a user might
    // have registered with password first and linked GitHub after).
    let user = await this.userRepository.findOne({ where: { email: primaryEmail } });
    if (!user) {
      user = this.userRepository.create({
        email: primaryEmail,
        name: githubUser.data.name || githubUser.data.login,
        role: Role.User,
        githubId: String(githubUser.data.id),
      } as Partial<User>);
      user = await this.userRepository.save(user);
      this.logger.log(`Created new user via GitHub OAuth: ${primaryEmail} (${githubUser.data.login})`);
    } else if (!user.githubId) {
      user.githubId = String(githubUser.data.id);
      user = await this.userRepository.save(user);
      this.logger.log(`Linked existing user ${primaryEmail} to GitHub account ${githubUser.data.login}`);
    }

    await this.ensureDefaultMembership(user.id);
    const org = await this.defaultOrgIdFor(user.id);

    // Upsert github_connections keyed by users.id UUID. Cleans up any
    // legacy row that happened to key by email string; migration 017
    // already purged those but we defensively handle a double-insert.
    const now = new Date();
    const accessTokenExpiresAt = tokenPayload.expires_in
      ? new Date(now.getTime() + tokenPayload.expires_in * 1000)
      : null;
    const refreshTokenExpiresAt = tokenPayload.refresh_token_expires_in
      ? new Date(now.getTime() + tokenPayload.refresh_token_expires_in * 1000)
      : null;

    const existing = await this.githubConnectionRepository.findOne({ where: { userId: user.id } });
    const connection = this.githubConnectionRepository.create({
      id: existing?.id,
      userId: user.id,
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token ?? null,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      tokenType: tokenPayload.token_type || 'bearer',
      scope: tokenPayload.scope || null,
      githubLogin: githubUser.data.login,
      githubId: String(githubUser.data.id),
    });
    await this.githubConnectionRepository.save(connection);

    const tokens = await this.generateTokenPair(user.id, user.email, user.role, org?.id);
    // Rotate app refresh token hash alongside the GitHub one.
    user.refreshToken = await bcrypt.hash(tokens.refreshToken, 10);
    await this.userRepository.save(user);

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name ?? githubUser.data.name ?? githubUser.data.login,
        githubLogin: githubUser.data.login,
        githubId: String(githubUser.data.id),
      },
      org,
    };
  }

  /** Register a new user with email + password */
  async register(email: string, password: string, name?: string) {
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw new UnauthorizedException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = this.userRepository.create({
      email,
      passwordHash,
      name,
      role: Role.User,
    });
    const saved = await this.userRepository.save(user);

    // Phase 9: auto-assign new users to the Default org as owner so every
    // issued token carries a valid orgId from the first request.
    await this.ensureDefaultMembership(saved.id);
    const org = await this.defaultOrgIdFor(saved.id);
    const tokens = await this.generateTokenPair(saved.id, saved.email, saved.role, org?.id);

    // Store refresh token hash
    saved.refreshToken = await bcrypt.hash(tokens.refreshToken, 10);
    await this.userRepository.save(saved);

    return {
      ...tokens,
      user: { id: saved.id, email: saved.email, role: saved.role, name: saved.name },
    };
  }

  /** Validate email + password login */
  async loginWithPassword(email: string, password: string) {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.ensureDefaultMembership(user.id);
    const org = await this.defaultOrgIdFor(user.id);
    const tokens = await this.generateTokenPair(user.id, user.email, user.role, org?.id);

    // Store refresh token hash
    user.refreshToken = await bcrypt.hash(tokens.refreshToken, 10);
    await this.userRepository.save(user);

    return {
      ...tokens,
      user: { id: user.id, email: user.email, role: user.role, name: user.name },
    };
  }

  /** Phase 9: re-issue a token pair scoped to a different org the user belongs to. */
  async switchOrg(userId: string, targetOrgId: string) {
    const membership = await this.orgMembershipRepository.findOne({
      where: { userId, orgId: targetOrgId },
    });
    if (!membership) {
      throw new UnauthorizedException('Not a member of that organization');
    }
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const tokens = await this.generateTokenPair(user.id, user.email, user.role, targetOrgId);
    user.refreshToken = await bcrypt.hash(tokens.refreshToken, 10);
    await this.userRepository.save(user);
    return {
      ...tokens,
      orgId: targetOrgId,
      user: { id: user.id, email: user.email, role: user.role, name: user.name },
    };
  }

  /** Generate access + refresh token pair */
  private async generateTokenPair(userId: string, email: string, role: Role, orgId?: string) {
    const payload: JwtPayload = { sub: userId, email, role, roles: [role], userId, orgId };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      { sub: userId, type: 'refresh' },
      { expiresIn: '30d' },
    );

    return {
      accessToken,
      access_token: accessToken,
      refreshToken,
      token_type: 'Bearer',
    };
  }

  /** Refresh access token using a valid refresh token */
  async refreshToken(refreshToken: string) {
    try {
      const decoded = this.jwtService.verify(refreshToken) as { sub: string; type?: string };
      if (decoded.type !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.userRepository.findOne({ where: { id: decoded.sub } });
      if (!user || !user.refreshToken) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const valid = await bcrypt.compare(refreshToken, user.refreshToken);
      if (!valid) {
        throw new UnauthorizedException('Refresh token has been revoked');
      }

      const org = await this.defaultOrgIdFor(user.id);
      const tokens = await this.generateTokenPair(user.id, user.email, user.role, org?.id);

      // Rotate refresh token
      user.refreshToken = await bcrypt.hash(tokens.refreshToken, 10);
      await this.userRepository.save(user);

      return {
        ...tokens,
        user: { id: user.id, email: user.email, role: user.role, name: user.name },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}
