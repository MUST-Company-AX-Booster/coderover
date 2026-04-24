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
@Injectable()
export class GitHubAppService {
  private readonly logger = new Logger(GitHubAppService.name);
  private installationTokenCache = new Map<number, { token: string; expiresAt: number }>();

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
}
