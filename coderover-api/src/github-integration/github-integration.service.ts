import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Octokit } from '@octokit/rest';
import { Repository } from 'typeorm';
import { GithubConnection } from '../entities/github-connection.entity';
import { SetupWebhookDto } from './dto/setup-webhook.dto';

@Injectable()
export class GitHubIntegrationService {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(GithubConnection)
    private readonly connectionRepository: Repository<GithubConnection>,
  ) {}

  getConnectUrl(state: string, userId: string) {
    const clientId = this.configService.get<string>('GITHUB_CLIENT_ID', '');
    const callbackUrl = this.configService.get<string>('GITHUB_CALLBACK_URL', '');
    const scope = 'repo,read:org,admin:repo_hook';
    const effectiveState = state || `${userId}:${Date.now()}`;
    return {
      authUrl: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(effectiveState)}`,
      callbackUrl,
      state: effectiveState,
      configured: Boolean(clientId && callbackUrl),
    };
  }

  async handleCallback(code: string, userId: string, state?: string) {
    const clientId = this.configService.get<string>('GITHUB_CLIENT_ID', '');
    const clientSecret = this.configService.get<string>('GITHUB_CLIENT_SECRET', '');
    if (!clientId || !clientSecret) {
      throw new BadRequestException('GitHub OAuth is not configured');
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
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenResponse.ok || !tokenPayload.access_token) {
      throw new UnauthorizedException(tokenPayload.error_description || tokenPayload.error || 'OAuth exchange failed');
    }

    const octokit = new Octokit({ auth: tokenPayload.access_token });
    const githubUser = await octokit.users.getAuthenticated();

    const existing = await this.connectionRepository.findOne({ where: { userId } });
    const connection = this.connectionRepository.create({
      id: existing?.id,
      userId,
      accessToken: tokenPayload.access_token,
      tokenType: tokenPayload.token_type || 'bearer',
      scope: tokenPayload.scope || null,
      githubLogin: githubUser.data.login,
      githubId: String(githubUser.data.id),
    });
    await this.connectionRepository.save(connection);

    return {
      connected: true,
      codeReceived: Boolean(code),
      state: state || null,
      githubLogin: githubUser.data.login,
      scopes: tokenPayload.scope?.split(',').filter(Boolean) ?? [],
      message: 'GitHub OAuth connection established',
    };
  }

  async listRepos(userId: string) {
    const connection = await this.connectionRepository.findOne({ where: { userId } });
    if (!connection?.accessToken) {
      throw new UnauthorizedException('No GitHub connection for this user');
    }

    const octokit = new Octokit({ auth: connection.accessToken });
    const repos = await octokit.repos.listForAuthenticatedUser({
      affiliation: 'owner,collaborator,organization_member',
      per_page: 100,
      sort: 'updated',
    });

    return {
      items: repos.data.map((repo) => ({
        id: repo.id,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        updatedAt: repo.updated_at,
      })),
      connectedAs: connection.githubLogin,
    };
  }

  async setupWebhook(dto: SetupWebhookDto, userId: string) {
    const baseUrl = this.configService.get<string>('PUBLIC_API_BASE_URL', 'http://localhost:3001');
    const webhookSecret = this.configService.get<string>('GITHUB_WEBHOOK_SECRET', '');
    const connection = await this.connectionRepository.findOne({ where: { userId } });
    if (!connection?.accessToken) {
      throw new UnauthorizedException('No GitHub connection for this user');
    }

    const [owner, repoName] = dto.repo.split('/');
    if (!owner || !repoName) {
      throw new BadRequestException('repo must be in owner/repo format');
    }

    const events = [];
    if (dto.pullRequestEvents !== false) events.push('pull_request');
    if (dto.pushEvents !== false) events.push('push');
    if (events.length === 0) {
      throw new BadRequestException('At least one webhook event must be enabled');
    }

    const octokit = new Octokit({ auth: connection.accessToken });
    const response = await octokit.repos.createWebhook({
      owner,
      repo: repoName,
      config: {
        url: `${baseUrl}/webhooks/github`,
        content_type: 'json',
        secret: webhookSecret,
      },
      events,
      active: true,
    });

    return {
      ok: true,
      repo: dto.repo,
      branch: dto.branch || 'main',
      events,
      webhookUrl: `${baseUrl}/webhooks/github`,
      webhookId: response.data.id,
      message: 'Webhook registered on GitHub',
    };
  }
}
