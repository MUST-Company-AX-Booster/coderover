import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { GithubConnection } from '../entities/github-connection.entity';
import { GitHubAppService } from './github-app.service';
import { GitHubTokenResolver, TokenResolverInput } from './github-token-resolver.service';

/**
 * Unit tests for the Phase 2B precedence chain in GitHubTokenResolver.
 *
 * The resolver picks one of:
 *   1. App installation token (when App configured AND repo identity supplied
 *      AND install lookup returns a non-null id)
 *   2. OAuth user token (from github_connections by user id)
 *   3. Per-repo PAT (input.githubToken)
 *   4. Env GITHUB_TOKEN
 *   5. empty string (caller treats as unauthenticated)
 *
 * We stub `GitHubAppService` so the actual JWT signing / Octokit
 * round-trip is never exercised here.
 */
describe('GitHubTokenResolver — Phase 2B precedence', () => {
  function makeConnectionsRepo(
    findOneReturn: GithubConnection | null,
  ): Repository<GithubConnection> {
    const findOne = jest.fn(async () => findOneReturn);
    return { findOne } as unknown as Repository<GithubConnection>;
  }

  function makeConfig(envToken: string | undefined): ConfigService {
    const get = jest.fn((key: string) => (key === 'GITHUB_TOKEN' ? envToken : undefined));
    return { get } as unknown as ConfigService;
  }

  interface AppStub {
    isConfigured: jest.Mock<boolean, []>;
    findInstallationForRepo: jest.Mock<Promise<number | null>, [string, string]>;
    getInstallationToken: jest.Mock<Promise<string>, [number]>;
  }

  function makeAppService(opts: {
    configured: boolean;
    installationId?: number | null;
    installationToken?: string;
    findThrows?: Error;
    mintThrows?: Error;
  }): AppStub {
    return {
      isConfigured: jest.fn<boolean, []>(() => opts.configured),
      findInstallationForRepo: jest.fn<Promise<number | null>, [string, string]>(
        async () => {
          if (opts.findThrows) throw opts.findThrows;
          return opts.installationId ?? null;
        },
      ),
      getInstallationToken: jest.fn<Promise<string>, [number]>(async () => {
        if (opts.mintThrows) throw opts.mintThrows;
        return opts.installationToken ?? 'ghs_app_install_token';
      }),
    };
  }

  function makeResolver(
    connRepo: Repository<GithubConnection>,
    config: ConfigService,
    app: AppStub,
  ): GitHubTokenResolver {
    return new GitHubTokenResolver(
      connRepo,
      config,
      app as unknown as GitHubAppService,
    );
  }

  it('prefers App installation token when configured + install present + identity supplied', async () => {
    const conn = { accessToken: 'gho_oauth_should_not_be_used' } as GithubConnection;
    const resolver = makeResolver(
      makeConnectionsRepo(conn),
      makeConfig('ghp_env_should_not_be_used'),
      makeAppService({ configured: true, installationId: 42, installationToken: 'ghs_INSTALL' }),
    );
    const token = await resolver.resolveFor({
      connectedByUserId: 'user-1',
      githubToken: 'ghp_pat_should_not_be_used',
      fullName: 'octocat/hello',
    });
    expect(token).toBe('ghs_INSTALL');
  });

  it('falls back to OAuth when App configured but install absent (404 / null)', async () => {
    const conn = { accessToken: 'gho_oauth_token' } as GithubConnection;
    const resolver = makeResolver(
      makeConnectionsRepo(conn),
      makeConfig(undefined),
      makeAppService({ configured: true, installationId: null }),
    );
    const token = await resolver.resolveFor({
      connectedByUserId: 'user-1',
      fullName: 'octocat/hello',
    });
    expect(token).toBe('gho_oauth_token');
  });

  it('falls back to OAuth when App lookup throws (network glitch)', async () => {
    const conn = { accessToken: 'gho_oauth_token' } as GithubConnection;
    const app = makeAppService({
      configured: true,
      installationId: 42,
      findThrows: new Error('upstream 503'),
    });
    const resolver = makeResolver(
      makeConnectionsRepo(conn),
      makeConfig(undefined),
      app,
    );
    const token = await resolver.resolveFor({
      connectedByUserId: 'user-1',
      fullName: 'octocat/hello',
    });
    expect(token).toBe('gho_oauth_token');
    expect(app.findInstallationForRepo).toHaveBeenCalledTimes(1);
  });

  it('falls back to OAuth when App is not configured (skips lookup entirely)', async () => {
    const conn = { accessToken: 'gho_oauth_token' } as GithubConnection;
    const app = makeAppService({ configured: false });
    const resolver = makeResolver(
      makeConnectionsRepo(conn),
      makeConfig(undefined),
      app,
    );
    const token = await resolver.resolveFor({
      connectedByUserId: 'user-1',
      fullName: 'octocat/hello',
    });
    expect(token).toBe('gho_oauth_token');
    expect(app.findInstallationForRepo).not.toHaveBeenCalled();
  });

  it('falls back to PAT when no OAuth + no App install', async () => {
    const resolver = makeResolver(
      makeConnectionsRepo(null),
      makeConfig(undefined),
      makeAppService({ configured: true, installationId: null }),
    );
    const token = await resolver.resolveFor({
      githubToken: 'ghp_pat',
      fullName: 'octocat/hello',
    });
    expect(token).toBe('ghp_pat');
  });

  it('falls back to env GITHUB_TOKEN as last resort', async () => {
    const resolver = makeResolver(
      makeConnectionsRepo(null),
      makeConfig('ghp_env_fallback'),
      makeAppService({ configured: false }),
    );
    const token = await resolver.resolveFor({});
    expect(token).toBe('ghp_env_fallback');
  });

  it('returns empty string when nothing is configured', async () => {
    const resolver = makeResolver(
      makeConnectionsRepo(null),
      makeConfig(undefined),
      makeAppService({ configured: false }),
    );
    expect(await resolver.resolveFor({})).toBe('');
  });

  it('skips App path when fullName is missing (no repo identity)', async () => {
    const conn = { accessToken: 'gho_oauth_token' } as GithubConnection;
    const app = makeAppService({ configured: true, installationId: 42 });
    const resolver = makeResolver(
      makeConnectionsRepo(conn),
      makeConfig(undefined),
      app,
    );
    const token = await resolver.resolveFor({
      connectedByUserId: 'user-1',
      // no fullName, no owner+name
    } as TokenResolverInput);
    expect(token).toBe('gho_oauth_token');
    expect(app.findInstallationForRepo).not.toHaveBeenCalled();
  });

  it('accepts split owner+name as an alternative to fullName', async () => {
    const app = makeAppService({
      configured: true,
      installationId: 42,
      installationToken: 'ghs_split',
    });
    const resolver = makeResolver(
      makeConnectionsRepo(null),
      makeConfig(undefined),
      app,
    );
    const token = await resolver.resolveFor({ owner: 'octocat', name: 'hello' });
    expect(token).toBe('ghs_split');
    expect(app.findInstallationForRepo).toHaveBeenCalledWith('octocat', 'hello');
  });

  it('falls back to OAuth when minting the install token fails', async () => {
    const conn = { accessToken: 'gho_oauth_token' } as GithubConnection;
    const app = makeAppService({
      configured: true,
      installationId: 42,
      mintThrows: new Error('GitHub API 500'),
    });
    const resolver = makeResolver(
      makeConnectionsRepo(conn),
      makeConfig(undefined),
      app,
    );
    const token = await resolver.resolveFor({
      connectedByUserId: 'user-1',
      fullName: 'octocat/hello',
    });
    expect(token).toBe('gho_oauth_token');
  });
});
