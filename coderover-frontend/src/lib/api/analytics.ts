import { API_BASE_URL, getAuthHeaders } from './client';

export const analyticsApi = {
  /** Returns raw fetch Response for SSE streaming */
  stream: (range = '7d', signal?: AbortSignal) =>
    fetch(`${API_BASE_URL}/analytics/stream?range=${range}`, {
      headers: { ...getAuthHeaders() },
      signal,
    }),

  /** REST fallback for dashboard snapshot */
  dashboard: (range = '7d', signal?: AbortSignal) =>
    fetch(`${API_BASE_URL}/analytics/dashboard?range=${range}`, {
      headers: { ...getAuthHeaders() },
      signal,
    }).then((r) => r.json()),
};
