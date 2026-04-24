import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GithubConnection } from '../entities/github-connection.entity';

export interface TokenResolverInput {
  connectedByUserId?: string | null;
  githubToken?: string | null;
}

/**
 * Decide which GitHub token to use for a given repo, at the moment it's
 * needed. Precedence:
 *
 *   1. OAuth token from `github_connections` when the repo has a
 *      `connected_by_user_id` FK — always fresh (auto-rotates when the
 *      user re-authenticates, fails cleanly when they revoke).
 *   2. Per-repo PAT stored on `repos.github_token` — manual "Advanced"
 *      registration path.
 *   3. Global env `GITHUB_TOKEN` fallback — developer-box default and
 *      rescue for pre-OAuth repos.
 *
 * Call sites (`GitHubService.getOctokit`, `PrReviewService`, etc.) used
 * to hardcode the env fallback. Routing them through this resolver makes
 * the precedence auditable and lets the OAuth-selected path actually
 * benefit from token rotation.
 */
@Injectable()
export class GitHubTokenResolver {
  private readonly logger = new Logger(GitHubTokenResolver.name);

  constructor(
    @InjectRepository(GithubConnection)
    private readonly connections: Repository<GithubConnection>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolve the most-appropriate GitHub token for the given repo-like.
   * Returns an empty string if nothing is configured — callers should
   * treat that as "unauthenticated Octokit" (works for public repos,
   * fails for private).
   */
  async resolveFor(input: TokenResolverInput): Promise<string> {
    if (input.connectedByUserId) {
      const conn = await this.connections.findOne({
        where: { userId: input.connectedByUserId },
      });
      if (conn?.accessToken) {
        this.logger.debug(`Resolved token from github_connections for user ${input.connectedByUserId}`);
        return conn.accessToken;
      }
      this.logger.warn(
        `Repo linked to user ${input.connectedByUserId} but no github_connections row — falling back`,
      );
    }

    const pat = (input.githubToken || '').trim();
    if (pat) {
      return pat;
    }

    return this.configService.get<string>('GITHUB_TOKEN') ?? '';
  }
}
