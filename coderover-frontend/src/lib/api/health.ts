import { apiClient } from './client';

export interface HealthResponse {
  status?: string;
  timestamp?: string;
  components?: {
    database?: { status?: string; latencyMs?: number; error?: string };
    queue?: { status?: string; depth?: number; error?: string };
    llm?: { status?: string; latencyMs?: number; error?: string };
    watcher?: { status?: string; sessions?: number; error?: string };
  };
  metrics?: {
    embeddingCoverage?: {
      totalChunks?: number;
      embeddedChunks?: number;
      coveragePercent?: number;
    };
  };
}

export const healthApi = {
  check: () => apiClient.get<HealthResponse>('/health'),
};
