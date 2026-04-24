import { apiClient } from './client';

export interface AgentRun {
  id: string;
  repoId: string;
  agentType: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  trigger: string;
  startedAt?: string;
  completedAt?: string;
  llmTokensUsed: number;
  findingsCount: number;
  errorMessage?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentApproval {
  id: string;
  agentRunId: string;
  agentRun?: AgentRun;
  actionType: string;
  actionPayload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approvalToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface AgentRule {
  id: string;
  repoId: string | null;
  name: string;
  description: string;
  detectionPattern: Record<string, unknown>;
  severity: 'critical' | 'warning' | 'info';
  autoFixTemplate: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface EnforcerViolation {
  ruleId: string;
  name: string;
  severity: 'critical' | 'warning' | 'info';
  file: string;
  line: number;
  message: string;
}

export interface RefactorSuggestion {
  smellId: string;
  name: string;
  file: string;
  line?: number;
  severity: 'critical' | 'warning' | 'suggestion';
  message: string;
  context?: unknown;
}

export type AgentMemoryType = 'dismissed' | 'approved_pattern' | 'preference' | 'decision';

export interface AgentMemoryEntry {
  id: string;
  repoId: string;
  memoryType: AgentMemoryType;
  key: string;
  value: Record<string, unknown>;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStatus {
  activeRuns: number;
  queued: number;
}

export interface ApproveActionResponse {
  message: string;
  result?: {
    prUrl?: string;
    prNumber?: number;
    branchName?: string;
  };
}

export const agentApi = {
  getStatus: async (): Promise<AgentStatus> => {
    return apiClient.get<AgentStatus>('/agent/status');
  },

  getRuns: async (repoId: string): Promise<AgentRun[]> => {
    return apiClient.get<AgentRun[]>(`/agent/runs/${repoId}`);
  },

  triggerRun: async (repoId: string, type: string): Promise<unknown> => {
    if (type === 'enforcer') {
      return apiClient.post<unknown>(`/agent/enforcer/enforce/${repoId}`);
    }
    if (type === 'refactor') {
      return apiClient.post<unknown>('/agent/refactor/scan', { repoId });
    }
    throw new Error(`Manual trigger for ${type} not supported yet`);
  },

  getEnforcerViolations: async (repoId: string): Promise<EnforcerViolation[]> => {
    return apiClient.get<EnforcerViolation[]>(`/agent/enforcer/violations/${repoId}`);
  },

  getPendingApprovals: async (repoId?: string): Promise<AgentApproval[]> => {
    const params = repoId ? `?repoId=${repoId}` : '';
    return apiClient.get<AgentApproval[]>(`/agent/approval/pending${params}`);
  },

  approveAction: async (token: string): Promise<ApproveActionResponse> => {
    return apiClient.post<ApproveActionResponse>(`/agent/approval/${token}/approve`);
  },

  rejectAction: async (token: string): Promise<unknown> => {
    return apiClient.post<unknown>(`/agent/approval/${token}/reject`);
  },

  getRules: async (repoId: string): Promise<AgentRule[]> => {
    return apiClient.get<AgentRule[]>(`/agent/enforcer/rules/${repoId}`);
  },

  createRule: async (repoId: string, rule: Partial<AgentRule>): Promise<AgentRule> => {
    return apiClient.post<AgentRule>(`/agent/enforcer/rules/${repoId}`, rule);
  },

  scanRefactor: async (repoId: string): Promise<RefactorSuggestion[]> => {
    return apiClient.post<RefactorSuggestion[]>('/agent/refactor/scan', { repoId });
  },

  getRefactorSuggestions: async (repoId: string): Promise<RefactorSuggestion[]> => {
    return apiClient.get<RefactorSuggestion[]>(`/agent/refactor/suggestions/${repoId}`);
  },

  requestRefactorFix: async (
    repoId: string,
    suggestionId: string,
  ): Promise<{ message: string; approvalToken: string; approvalUrl: string }> => {
    return apiClient.post<{ message: string; approvalToken: string; approvalUrl: string }>(
      `/agent/refactor/fix/${repoId}/${encodeURIComponent(suggestionId)}`,
    );
  },

  listMemory: async (repoId: string, type?: AgentMemoryType): Promise<AgentMemoryEntry[]> => {
    const query = type ? `?type=${encodeURIComponent(type)}` : '';
    return apiClient.get<AgentMemoryEntry[]>(`/agent/memory/${repoId}${query}`);
  },

  createMemory: async (
    repoId: string,
    body: { type: AgentMemoryType; key: string; value: Record<string, unknown>; ttlDays?: number },
  ): Promise<AgentMemoryEntry> => {
    return apiClient.post<AgentMemoryEntry>(`/agent/memory/${repoId}`, body);
  },

  deleteMemory: async (repoId: string, id: string): Promise<void> => {
    await apiClient.delete<void>(`/agent/memory/${repoId}/${id}`);
  },
};
