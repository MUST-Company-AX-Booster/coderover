import { apiClient } from './client';

export const watcherApi = {
  start: (data: { repoId: string; localPath: string }) => apiClient.post('/watcher/start', data),
  stop: (repoId: string) => apiClient.delete(`/watcher/stop/${encodeURIComponent(repoId)}`),
  sessions: () => apiClient.get<Record<string, unknown>[]>('/watcher/sessions'),
};
