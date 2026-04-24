import { apiClient, API_BASE_URL, getAuthHeaders } from './client';

export interface ChatSession {
  id: string;
  title: string;
  repoIds?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Phase 10 B2 (in-flight) attaches these to RAG citations. Schema mirrors
 * the Postgres citation row: confidence tag + optional score + stable id
 * that the B4 evidence endpoint consumes. Legacy rows (pre-B1 migration)
 * come through as `AMBIGUOUS` with a null score.
 */
export type CitationConfidenceTag = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export interface SourceCitation {
  id: string;
  filePath: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  /** Legacy field — formatted "lineStart-lineEnd". Kept for backward compat. */
  lines?: string;
  similarity?: number;
  confidence: CitationConfidenceTag;
  confidenceScore?: number | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  toolCalls?: unknown;
  sourceChunks?: SourceCitation[];
}

export const copilotApi = {
  getSessions: () => apiClient.get<ChatSession[]>('/copilot/sessions'),
  getHistory: (sessionId: string) => apiClient.get<ChatMessage[]>(`/copilot/sessions/${sessionId}/history`),
  deleteSession: (sessionId: string) => apiClient.delete(`/copilot/sessions/${sessionId}`),

  /** Returns raw fetch Response for SSE streaming — caller must handle ReadableStream */
  streamChat: (payload: { message: string; stream?: boolean; sessionId?: string; repoIds?: string[] }, signal?: AbortSignal) =>
    fetch(`${API_BASE_URL}/copilot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ stream: true, ...payload }),
      signal,
    }),
};
