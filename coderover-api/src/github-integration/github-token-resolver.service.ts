import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GithubConnection } from '../entities/github-connection.entity';
import { GitHubAppService } from './github-app.service';

export interface TokenResolverInput {
  connectedByUserId?: string | null;
  githubToken?: string | null;
  /** `owner/name` — used to look up the App installation for this repo. */
  fullName?: string | null;
  /** Convenience: split form. Either fullName OR (owner+name) is used. */
  owner?: string | null;
  name?: string | null;
}

/**
 * Decide which GitHub token to use for a given repo, at the moment it's
 * needed. Precedence (Phase 2B):
 *
 *   1. **GitHub App installation token** — when the App is configured and
 *      installed on the repo's owner. Fine-grained per-install scope, no
 *      `repo` OAuth scope required, auto-rotates every hour. This is the
 *      Zero Trust target.
 *
 *   2. OAuth user token from `github_connections` — fallback when the App
 *      is not installed or not configured. Carries the broader `repo` scope
 *      (today). Always fresh; rotates when the user re-authenticates.
 *
 *   3. Per-repo PAT stored on `repos.github_token` — manual "Advanced"
 *      registration path. Staying for compatibility with existing repos.
 *
 *   4. Global env `GITHUB_TOKEN` — developer-box default and rescue.
 *
 * The migration path is: install the App on each org → installation tokens
 * start being preferred automatically (existing OAuth/PAT rows untouched)
 * → in a separate later PR we can reduce the OAuth scope from `repo` to
 * read-only, since it's no longer the primary credential.
 */
@Injectable()
export class GitHubTokenResolver {
  private readonly logger = new Logger(GitHubTokenResolver.name);

  constructor(
    @InjectRepository(GithubConnection)
    private readonly connections: Repository<GithubConnection>,
    private readonly configService: ConfigService,
    private readonly appService: GitHubAppService,
  ) {}

  /**
   * Resolve the most-appropriate GitHub token for the given repo-like.
   * Returns an empty string if nothing is configured — callers should
   * treat that as "unauthenticated Octokit" (works for public repos,
   * fails for private).
   */
  async resolveFor(input: TokenResolverInput): Promise<string> {
    // 1. App installation token — preferred whenever it can be obtained.
    const appToken = await this.tryInstallationToken(input);
    if (appToken) return appToken;

    // 2. OAuth user token — fallback while orgs migrate to the App.
    if (input.connectedByUserId) {
      const conn = await this.connections.findOne({
        where: { userId: input.connectedByUserId },
      });
      if (conn?.accessToken) {
        this.logger.debug(
          `Resolved OAuth token from github_connections for user ${input.connectedByUserId}`,
        );
        return conn.accessToken;
      }
      this.logger.warn(
        `Repo linked to user ${input.connectedByUserId} but no github_connections row — falling back`,
      );
    }

    // 3. Per-repo PAT.
    const pat = (input.githubToken || '').trim();
    if (pat) {
      return pat;
    }

    // 4. Global env fallback.
    return this.configService.get<string>('GITHUB_TOKEN') ?? '';
  }

  /**
   * Try the App-installation path. Returns null when the App isn't
   * configured, isn't installed on the repo, or the repo identity isn't
   * supplied. Never throws — caller falls through to the OAuth path on
   * any failure so a misbehaving GitHub API doesn't take down ingest.
   */
  private async tryInstallationToken(input: TokenResolverInput): Promise<string | null> {
    if (!this.appService.isConfigured()) return null;

    const { owner, name } = this.splitRepoIdentity(input);
    if (!owner || !name) return null;

    let installationId: number | null = null;
    try {
      installationId = await this.appService.findInstallationForRepo(owner, name);
    } catch (err) {
      this.logger.warn(
        `App installation lookup failed for ${owner}/${name}: ${(err as Error).message}`,
      );
      return null;
    }
    if (!installationId) return null;

    try {
      const token = await this.appService.getInstallationToken(installationId);
      this.logger.debug(`Resolved App installation token for ${owner}/${name}`);
      return token;
    } catch (err) {
      this.logger.warn(
        `Failed to mint App installation token for ${owner}/${name} (install ${installationId}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** `fullName` wins over (owner, name) — match call-site convention. */
  private splitRepoIdentity(input: TokenResolverInput): { owner: string; name: string } | { owner: null; name: null } {
    if (input.fullName) {
      const [owner, name] = input.fullName.split('/');
      if (owner && name) return { owner, name };
    }
    if (input.owner && input.name) {
      return { owner: input.owner, name: input.name };
    }
    return { owner: null, name: null };
  }
}
