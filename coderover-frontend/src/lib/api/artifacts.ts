import { apiClient } from './client';

export const artifactsApi = {
  list: (repoId?: string) => {
    const params = repoId ? `?repoId=${repoId}` : '';
    return apiClient.get<Record<string, unknown>[]>(`/artifacts/list${params}`);
  },
  search: (query: string, opts?: { repoId?: string; topK?: number; limit?: number }) => {
    const params = new URLSearchParams({ q: query });
    if (opts?.repoId) params.set('repoId', opts.repoId);
    if (opts?.topK) params.set('topK', String(opts.topK));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return apiClient.get<Record<string, unknown>[]>(`/artifacts/search?${params}`);
  },
  stats: (repoId?: string) => {
    const params = repoId ? `?repoId=${repoId}` : '';
    return apiClient.get<Record<string, unknown>>(`/artifacts/stats${params}`);
  },
};
