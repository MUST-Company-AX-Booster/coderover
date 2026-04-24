import { apiClient } from './client';

export interface GitHubRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export const githubApi = {
  connect: (state: string) =>
    apiClient.get<{ authUrl: string }>(`/github-integration/connect?state=${encodeURIComponent(state)}`, { suppressAuthLogout: true }),
  callback: (code: string, state: string) =>
    apiClient.get<Record<string, unknown>>(`/github-integration/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { suppressAuthLogout: true }),
  listRepos: () =>
    apiClient.request<{ items: GitHubRepo[] }>('/github-integration/repos', { method: 'GET', suppressAuthLogout: true }),
  setupWebhook: (repo: string, branch: string) =>
    apiClient.post<Record<string, unknown>>('/github-integration/webhooks/setup', { repo, branch }, { suppressAuthLogout: true }),
};
