import { apiClient } from './client';

export const debugApi = {
  retrieval: (data: { query: string; topK?: number; searchMode?: string }) =>
    apiClient.post<Record<string, unknown>>('/debug/retrieval', data),
};
