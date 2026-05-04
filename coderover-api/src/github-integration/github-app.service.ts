import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import * as jwt from 'jsonwebtoken';

/**
 * Phase 9 / Workstream B Phase 2: GitHub App integration.
 *
 * Handles:
 *   - Generating short-lived app JWTs (10m) from private key
 *   - Exchanging app JWT for installation tokens (scoped per repo install)
 *   - Posting check_run status updates
 *   - Posting pull request review comments
 *
 * Configuration (env / system_settings):
 *   GITHUB_APP_ID              numeric App ID
 *   GITHUB_APP_PRIVATE_KEY     PEM-encoded private key
 *
 * This is a scaffold — wire into PrReviewService once App credentials are
 * provisioned. See docs/runbooks/github-app-install.md (to be added).
 */
/**
 * Cache TTL for repo→installation lookups. Installations rarely change
 * (a repo gains/loses the App on the order of weeks), so 5min is plenty
 * to absorb hot-path traffic without staleness pain.
 */
const INSTALLATION_LOOKUP_TTL_MS = 5 * 60 * 1_000;

interface CachedInstallationLookup {
  installationId: number | null;
  cachedAt: number;
}

@Injectable()
export class GitHubAppService {
  private readonly logger = new Logger(GitHubAppService.name);
  private installationTokenCache = new Map<number, { token: string; expiresAt: number }>();
  private repoInstallationCache = new Map<string, CachedInstallationLookup>();
  private ownerInstallationCache = new Map<string, CachedInstallationLookup>();

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('GITHUB_APP_ID') &&
        this.configService.get<string>('GITHUB_APP_PRIVATE_KEY'),
    );
  }

  private signAppJwt(): string {
    const appId = this.configService.get<string>('GITHUB_APP_ID');
    const privateKey = this.configService.get<string>('GITHUB_APP_PRIVATE_KEY');
    if (!appId || !privateKey) throw new Error('GitHub App not configured');
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iat: now - 60, exp: now + 9 * 60, iss: appId },
      privateKey,
      { algorithm: 'RS256' },
    );
  }

  async getInstallationToken(installationId: number): Promise<string> {
    if (!this.isConfigured()) throw new Error('GitHub App not configured');
    const cached = this.installationTokenCache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const appJwt = this.signAppJwt();
    const octokit = new Octokit({ auth: appJwt });
    const res = await octokit.request(
      'POST /app/installations/{installation_id}/access_tokens',
      { installation_id: installationId },
    );
    const token = (res.data as any).token as string;
    const expiresAt = new Date((res.data as any).expires_at).getTime();
    this.installationTokenCache.set(installationId, { token, expiresAt });
    return token;
  }

  async installationClient(installationId: number): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  async createCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    headSha: string,
    status: 'in_progress' | 'queued' = 'in_progress',
  ): Promise<number> {
    const gh = await this.installationClient(installationId);
    const res = await gh.checks.create({
      owner,
      repo,
      name: 'CodeRover AI Review',
      head_sha: headSha,
      status,
      output: {
        title: 'CodeRover review running',
        summary: 'AI-driven code review in progress…',
      },
    });
    return res.data.id;
  }

  async completeCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    checkRunId: number,
    conclusion: 'success' | 'failure' | 'neutral' | 'action_required',
    summary: string,
    details?: string,
  ): Promise<void> {
    const gh = await this.installationClient(installationId);
    await gh.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      output: { title: 'CodeRover review complete', summary, text: details },
    });
  }

  async postReviewComments(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    comments: Array<{ path: string; line: number; body: string }>,
    event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE' = 'COMMENT',
  ): Promise<void> {
    const gh = await this.installationClient(installationId);
    await gh.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body,
      event,
      comments: comments.map(c => ({ path: c.path, line: c.line, body: c.body })),
    });
  }

  /**
   * Resolve which App installation has access to `owner/repo`. Returns the
   * installation id, or null when no install covers that repo. Cached for
   * INSTALLATION_LOOKUP_TTL_MS so repeated ingest/PR-review calls don't
   * hit GitHub on every request.
   *
   * Uses the App JWT (NOT an installation token) — only the App identity
   * itself can ask "which install owns this repo".
   */
  async findInstallationForRepo(owner: string, repo: string): Promise<number | null> {
    if (!this.isConfigured()) return null;
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const cached = this.repoInstallationCache.get(key);
    if (cached && Date.now() - cached.cachedAt < INSTALLATION_LOOKUP_TTL_MS) {
      return cached.installationId;
    }

    const installationId = await this.lookupInstallationForRepo(owner, repo);
    this.repoInstallationCache.set(key, { installationId, cachedAt: Date.now() });
    return installationId;
  }

  /**
   * Resolve which App installation covers a given account (`owner` may be
   * a user or org). Useful when we know the account but not a specific
   * repo — e.g. listing repos a user can ingest. Cached the same way as
   * findInstallationForRepo.
   */
  async findInstallationForOwner(owner: string): Promise<number | null> {
    if (!this.isConfigured()) return null;
    const key = owner.toLowerCase();
    const cached = this.ownerInstallationCache.get(key);
    if (cached && Date.now() - cached.cachedAt < INSTALLATION_LOOKUP_TTL_MS) {
      return cached.installationId;
    }

    const installationId = await this.lookupInstallationForOwner(owner);
    this.ownerInstallationCache.set(key, { installationId, cachedAt: Date.now() });
    return installationId;
  }

  /**
   * Drop the lookup caches. Called by the installation webhook handler
   * (when one is added) so newly-installed/uninstalled accounts aren't
   * served stale "no install" results for up to 5 minutes.
   */
  invalidateInstallationLookupCache(): void {
    this.repoInstallationCache.clear();
    this.ownerInstallationCache.clear();
  }

  /** Network call wrapped for testability — replace in unit tests. */
  protected async lookupInstallationForRepo(
    owner: string,
    repo: string,
  ): Promise<number | null> {
    try {
      const appJwt = this.signAppJwt();
      const octokit = new Octokit({ auth: appJwt });
      const res = await octokit.request('GET /repos/{owner}/{repo}/installation', {
        owner,
        repo,
      });
      return (res.data as { id: number }).id;
    } catch (err) {
      // 404 = "App not installed on this repo" — not an error worth alerting on.
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      this.logger.warn(
        `findInstallationForRepo(${owner}/${repo}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Network call wrapped for testability — replace in unit tests. */
  protected async lookupInstallationForOwner(owner: string): Promise<number | null> {
    try {
      const appJwt = this.signAppJwt();
      const octokit = new Octokit({ auth: appJwt });
      // Org and user installations land at different endpoints; we try org
      // first (most common for self-hosted CodeRover deploys) and fall back
      // to user.
      try {
        const res = await octokit.request('GET /orgs/{org}/installation', { org: owner });
        return (res.data as { id: number }).id;
      } catch (orgErr) {
        if ((orgErr as { status?: number }).status !== 404) throw orgErr;
        const res = await octokit.request('GET /users/{username}/installation', {
          username: owner,
        });
        return (res.data as { id: number }).id;
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      this.logger.warn(
        `findInstallationForOwner(${owner}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
