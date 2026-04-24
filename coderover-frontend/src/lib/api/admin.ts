import { apiClient } from './client';

export interface ManagedSetting {
  key: string;
  value: string | number | boolean | null;
  isSecret: boolean;
  isSet?: boolean;
  version: number;
  updatedAt: string;
}

export interface SettingAudit {
  id: string;
  key: string;
  previousValue: string | number | boolean | null;
  nextValue: string | number | boolean | null;
  version: number;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  openaiApiKeySet: boolean;
}

export const adminApi = {
  getSettings: () => apiClient.get<ManagedSetting[]>('/admin/settings'),
  updateSetting: (key: string, value: unknown, reason: string) =>
    apiClient.put(`/admin/settings/${key}`, { value, reason }),
  getAudit: (limit = 20) => apiClient.get<SettingAudit[]>(`/admin/settings/audit?limit=${limit}`),
  getLlmConfig: () => apiClient.get<LlmConfig>('/admin/llm/config'),
  updateLlmConfig: (data: Partial<LlmConfig & { apiKey?: string }>) =>
    apiClient.put('/admin/llm/config', data),
  testLlm: (data: { provider?: string; model?: string; prompt: string }) =>
    apiClient.post<Record<string, unknown>>('/admin/llm/test', data),
};
