import { apiClient } from './client';

export interface McpTool {
  name: string;
  description: string;
  parameters: Array<{ name: string; type: string; description: string; required: boolean }>;
}

export interface McpHistoryItem {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs: number;
  createdAt: string;
}

export const mcpApi = {
  tools: () => apiClient.get<McpTool[]>('/mcp/tools'),
  history: (limit = 15) => apiClient.get<McpHistoryItem[]>(`/mcp/history?limit=${limit}`),
  execute: (tool: string, args: Record<string, unknown>) =>
    apiClient.post<Record<string, unknown>>('/mcp/execute', { tool, args }),
};
