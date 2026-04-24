import { apiClient } from './client';

export interface PrReviewItem {
  id: string;
  repo: string;
  prNumber: number;
  status: string;
  createdAt: string;
  score?: number;
  recommendation?: string;
}

export interface ReviewFinding {
  severity: 'critical' | 'warning' | 'suggestion' | 'info';
  file: string;
  line?: number;
  message: string;
  category: 'security' | 'performance' | 'correctness' | 'style' | 'maintainability';
}

export interface ReviewDetail {
  prNumber: number;
  repo: string;
  summary?: string;
  findings: ReviewFinding[];
  score: number;
  recommendation: 'approve' | 'request_changes' | 'comment';
  postedCommentUrl?: string | null;
  prReviewId?: string;
  tokensUsed?: number | null;
  id?: string;
  status?: string;
  diffSummary?: string;
  aiModel?: string;
  llmLatencyMs?: number;
  llmDurationMs?: number;
  totalTokens?: number;
  createdAt?: string;
  reviewUrl?: string;
}

export interface WebhookEvent {
  id: string;
  eventType: string;
  processed: boolean;
  createdAt: string;
}

export const prReviewApi = {
  list: (limit = 25) => apiClient.get<PrReviewItem[]>(`/pr-review/list?limit=${limit}`),
  get: (owner: string, repo: string, prNumber: number) =>
    apiClient.get<ReviewDetail>(`/pr-review/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${prNumber}`),
  trigger: (data: { repo: string; prNumber: number; postComment: boolean }) =>
    apiClient.post<ReviewDetail>('/pr-review/trigger', data),
  webhookEvents: (limit = 25) => apiClient.get<WebhookEvent[]>(`/webhooks/events?limit=${limit}`),
};
