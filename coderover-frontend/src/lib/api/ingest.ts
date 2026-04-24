import { apiClient } from './client';

export const ingestApi = {
  trigger: (data: { repo: string; branch: string; repoId?: string }) =>
    apiClient.post('/ingest/trigger', data),
  triggerSync: (data: { repo: string; branch: string; repoId?: string }) =>
    apiClient.post('/ingest/trigger-sync', data),
  status: (repo: string) =>
    apiClient.get<Record<string, unknown>>(`/ingest/status?repo=${encodeURIComponent(repo)}`),
  stats: () => apiClient.get<Record<string, unknown>>('/ingest/stats'),
  githubTest: (repo: string, branch: string) =>
    apiClient.get<Record<string, unknown>>(`/ingest/github-test?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`),
};
