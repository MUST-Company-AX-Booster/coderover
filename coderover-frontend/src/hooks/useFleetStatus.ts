import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import type { RoverName, RoverStatus } from '@/components/brand';

/**
 * Fleet status is derived from the /health endpoint — no dedicated backend
 * endpoint exists yet. Each rover maps to one or more real health signals:
 *
 *   [scout]    → queue + watcher (pr ingestion)
 *   [tinker]   → llm              (refactor proposals need a model)
 *   [sentinel] → llm              (security analysis needs a model)
 *   [beacon]   → watcher + db     (health/metrics reporter)
 *   [archive]  → embeddingCoverage (decision memory coverage)
 *
 * Notes are mission-control voice, showing real numbers. Never "Everything is
 * great!" — always a concrete signal or an honest failure line.
 */

export interface HealthComponent {
  status: 'up' | 'down';
  [k: string]: unknown;
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  components: {
    database: HealthComponent & { latencyMs?: number };
    queue: HealthComponent & { name?: string; depth?: number; counts?: Record<string, number> };
    watcher: HealthComponent & { enabled?: boolean; sessions?: number };
    llm: HealthComponent & { provider?: string; latencyMs?: number; error?: string };
  };
  metrics: {
    embeddingCoverage: {
      totalChunks: number;
      embeddedChunks: number;
      coveragePercent?: number;
      ratio?: number;
    };
  };
}

export interface FleetMember {
  unit: 1 | 2 | 3 | 4 | 5;
  name: RoverName;
  role: string;
  status: RoverStatus;
  note: string;
}

export const FALLBACK_FLEET: FleetMember[] = [
  { unit: 1, name: 'Scout', role: 'pr-review agent', status: 'offline', note: '[scout] awaiting contact.' },
  { unit: 2, name: 'Tinker', role: 'refactor agent', status: 'offline', note: '[tinker] awaiting contact.' },
  { unit: 3, name: 'Sentinel', role: 'security agent', status: 'offline', note: '[sentinel] awaiting contact.' },
  { unit: 4, name: 'Beacon', role: 'health-report agent', status: 'offline', note: '[beacon] downlink lost.' },
  { unit: 5, name: 'Archive', role: 'decision-memory agent', status: 'offline', note: '[archive] awaiting contact.' },
];

export function deriveFleet(h: HealthResponse): FleetMember[] {
  const dbUp = h.components.database?.status === 'up';
  const queueUp = h.components.queue?.status === 'up';
  const queueDepth = h.components.queue?.depth ?? 0;
  const watcherUp = h.components.watcher?.status === 'up';
  const watcherEnabled = h.components.watcher?.enabled ?? false;
  const watcherSessions = h.components.watcher?.sessions ?? 0;
  const llmUp = h.components.llm?.status === 'up';
  const llmError = h.components.llm?.error;

  const emb = h.metrics?.embeddingCoverage;
  const embedded = emb?.embeddedChunks ?? 0;
  const total = emb?.totalChunks ?? 0;
  const fullCoverage = total > 0 && embedded === total;

  const llmDownNote = llmError ? `[llm] ${llmError}` : '[llm] down.';

  return [
    {
      unit: 1,
      name: 'Scout',
      role: 'pr-review agent',
      status: queueUp ? (watcherSessions > 0 ? 'online' : 'armed') : 'offline',
      note: queueUp
        ? `queue depth ${queueDepth} · ${watcherSessions} session${watcherSessions === 1 ? '' : 's'}`
        : '[scout] queue down.',
    },
    {
      unit: 2,
      name: 'Tinker',
      role: 'refactor agent',
      status: llmUp ? 'armed' : 'offline',
      note: llmUp ? 'Proposals on demand.' : llmDownNote,
    },
    {
      unit: 3,
      name: 'Sentinel',
      role: 'security agent',
      status: llmUp ? 'patrolling' : 'offline',
      note: llmUp ? 'Patrol running 24/7.' : llmDownNote,
    },
    {
      unit: 4,
      name: 'Beacon',
      role: 'health-report agent',
      status: watcherUp && watcherEnabled && dbUp ? 'patrolling' : 'offline',
      note: watcherUp
        ? `watcher ${watcherEnabled ? 'enabled' : 'disabled'} · db ${h.components.database?.latencyMs ?? '?'}ms`
        : '[beacon] downlink lost.',
    },
    {
      unit: 5,
      name: 'Archive',
      role: 'decision-memory agent',
      status: total === 0 ? 'armed' : fullCoverage ? 'online' : 'patrolling',
      note:
        total === 0
          ? '[archive] no chunks indexed yet.'
          : `${embedded.toLocaleString()} / ${total.toLocaleString()} chunks indexed.`,
    },
  ];
}

export interface UseFleetStatusResult {
  fleet: FleetMember[];
  isLoading: boolean;
  error: string | null;
  lastUpdated: string | null;
}

export function useFleetStatus(pollMs = 15000): UseFleetStatusResult {
  const [fleet, setFleet] = useState<FleetMember[]>(FALLBACK_FLEET);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchOnce() {
      try {
        const data = await apiClient.get<HealthResponse>('/health', { suppressAuthLogout: true });
        if (cancelled) return;
        setFleet(deriveFleet(data));
        setLastUpdated(data.timestamp);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setFleet(FALLBACK_FLEET);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchOnce();
    const id = window.setInterval(fetchOnce, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return { fleet, isLoading, error, lastUpdated };
}
