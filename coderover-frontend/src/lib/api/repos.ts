import { apiClient } from './client';

export interface Repository {
  id: string;
  fullName: string;
  label: string | null;
  branch: string;
  language: string | null;
  framework?: string | null;
  fileCount: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RepoStatus {
  syncStatus?: string;
  status?: string;
  lastSyncAt?: string;
  syncedAt?: string;
  totalChunks?: number;
  totalFiles?: number;
  lastCommitSha?: string;
}

/**
 * Union shape for creating a repo: OAuth-backed (preferred) or manual
 * URL+PAT (Advanced fallback). The backend `RegisterRepoDto` accepts
 * both, with `connectedByUserId` and `githubToken` mutually exclusive
 * (server-enforced).
 */
export type CreateRepoInput =
  | {
      repoUrl: string;
      connectedByUserId: string;
      githubRepoId?: number;
      branch?: string;
      label?: string;
    }
  | {
      repoUrl: string;
      githubToken?: string;
      branch?: string;
      label?: string;
    };

export const reposApi = {
  list: () => apiClient.get<Repository[]>('/repos'),
  get: (id: string) => apiClient.get<Repository>(`/repos/${id}`),
  create: (data: CreateRepoInput) => apiClient.post<Repository>('/repos', data),
  update: (id: string, data: { label?: string; branch?: string; githubToken?: string }) =>
    apiClient.put<Repository>(`/repos/${id}`, data),
  deactivate: (id: string) => apiClient.delete(`/repos/${id}`),
  hardDelete: (id: string) => apiClient.delete(`/repos/${id}/hard`),
  ingest: (id: string) => apiClient.post(`/repos/${id}/ingest`),
  status: (id: string) => apiClient.get<RepoStatus>(`/repos/${id}/status`),
};
