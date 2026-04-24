import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export interface DashboardSnapshot {
  stats: {
    totalRepos: number;
    totalChunks: number;
    totalArtifacts: number;
    activeSessions: number;
    lastSyncAt: string | null;
    systemHealth: 'healthy' | 'warning' | 'error';
  };
  dailyUsage: Array<{
    date: string;
    chats: number;
    searches: number;
    users: number;
  }>;
  repoStats: Array<{
    name: string;
    chunks: number;
    artifacts: number;
    lastSync: string;
  }>;
  languageDistribution: Array<{
    language: string;
    count: number;
    percentage: number;
  }>;
  topQueries: Array<{
    query: string;
    frequency: number;
    category: string;
  }>;
  systemMetrics: {
    totalChats: number;
    totalSearches: number;
    activeUsers: number;
    avgResponseTime: number;
    responseTimeTrendDelta: number;
    responseTimePercentiles: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
    tokenUsage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    totalChunks: number;
    totalArtifacts: number;
  };
  responseTimeSeries: Array<{
    date: string;
    avgMs: number;
    p50Ms: number;
    p90Ms: number;
    p99Ms: number;
    totalTokens: number;
  }>;
  responseTimeByRepo: Array<{
    repo: string;
    requests: number;
    avgMs: number;
    p50Ms: number;
    p90Ms: number;
    p99Ms: number;
    totalTokens: number;
  }>;
  recentActivity: Array<{
    id: string;
    type: 'ingest' | 'chat' | 'sync';
    message: string;
    timestamp: string;
    status: 'success' | 'warning' | 'error';
  }>;
  generatedAt: string;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export function useAnalyticsLive(range: string) {
  const { token } = useAuthStore();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamUrl = useMemo(
    () => `${API_BASE_URL}/analytics/stream?range=${encodeURIComponent(range)}`,
    [range],
  );

  const fetchSnapshot = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/analytics/dashboard?range=${encodeURIComponent(range)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        throw new Error(`Snapshot request failed (${response.status})`);
      }
      const data = (await response.json()) as DashboardSnapshot;
      setSnapshot(data);
      setLastUpdated(data.generatedAt || new Date().toISOString());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch analytics snapshot');
    } finally {
      setIsLoading(false);
    }
  }, [range, token]);

  const connect = useCallback(async () => {
    if (!token) {
      setIsLoading(false);
      setError('Authentication required');
      return;
    }

    abortRef.current?.abort();
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Live stream unavailable (${response.status})`);
      }

      setError(null);
      setIsLoading(false);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let event = 'message';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n');
        buffer = chunks.pop() ?? '';

        for (const line of chunks) {
          if (line.startsWith('event:')) {
            event = line.replace('event:', '').trim();
            continue;
          }
          if (!line.startsWith('data:')) {
            continue;
          }

          const payloadText = line.replace('data:', '').trim();
          if (!payloadText) continue;

          if (event === 'snapshot') {
            const payload = JSON.parse(payloadText) as DashboardSnapshot;
            setSnapshot(payload);
            setLastUpdated(payload.generatedAt || new Date().toISOString());
            setError(null);
          }

          if (event === 'error') {
            const payload = JSON.parse(payloadText) as { message?: string };
            setError(payload.message || 'Live analytics error');
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Live stream disconnected');
      await fetchSnapshot();
      reconnectRef.current = setTimeout(() => {
        void connect();
      }, 5000);
    }
  }, [fetchSnapshot, streamUrl, token]);

  useEffect(() => {
    void fetchSnapshot();
    void connect();
    return () => {
      abortRef.current?.abort();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [connect, fetchSnapshot]);

  return {
    snapshot,
    isLoading,
    error,
    lastUpdated,
    refresh: fetchSnapshot,
  };
}
