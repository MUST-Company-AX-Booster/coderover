import { useState, useEffect } from 'react';
import {
  CheckCircle, AlertCircle, XCircle, RefreshCw,
  Database, Server, Activity, Clock, TrendingUp, Eye, Layers,
} from 'lucide-react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Eyebrow, AgentStatusLine } from '@/components/brand';

interface ServiceCheck {
  status: 'ok' | 'error';
  label: string;
  description: string;
  latency: number;
  detail?: string;
  icon: typeof Database;
}

interface RawHealthResponse {
  status?: string;
  timestamp?: string;
  components?: {
    database?: { status?: string; latencyMs?: number; error?: string };
    queue?: { status?: string; depth?: number; error?: string };
    llm?: { status?: string; latencyMs?: number; error?: string };
    watcher?: { status?: string; sessions?: number; error?: string };
  };
  metrics?: {
    embeddingCoverage?: { totalChunks?: number; embeddedChunks?: number; coveragePercent?: number };
  };
}

interface HealthData {
  overallStatus: 'ok' | 'degraded' | 'error';
  timestamp: string;
  services: ServiceCheck[];
  queueDepth: number;
  watcherSessions: number;
  embeddingCoverage: { totalChunks: number; embeddedChunks: number; coveragePercent: number };
}

const normalizeHealth = (raw: RawHealthResponse): HealthData => {
  const toStatus = (s?: string): 'ok' | 'error' => (s === 'up' ? 'ok' : 'error');
  const overall = raw.status === 'ok' ? 'ok' : raw.status === 'degraded' ? 'degraded' : 'error';
  return {
    overallStatus: overall as HealthData['overallStatus'],
    timestamp: raw.timestamp || new Date().toISOString(),
    services: [
      { status: toStatus(raw.components?.database?.status), label: 'Database', description: 'PostgreSQL + pgvector', latency: raw.components?.database?.latencyMs ?? 0, detail: raw.components?.database?.error, icon: Database },
      { status: toStatus(raw.components?.queue?.status), label: 'Redis Queue', description: 'Bull job queue', latency: 0, detail: raw.components?.queue?.error || (raw.components?.queue?.depth != null ? `${raw.components.queue.depth} jobs` : undefined), icon: Server },
      { status: toStatus(raw.components?.llm?.status), label: 'LLM Provider', description: 'AI model connectivity', latency: raw.components?.llm?.latencyMs ?? 0, detail: raw.components?.llm?.error, icon: Activity },
      { status: toStatus(raw.components?.watcher?.status), label: 'File Watcher', description: 'Local file monitoring', latency: 0, detail: raw.components?.watcher?.error || (raw.components?.watcher?.sessions != null ? `${raw.components.watcher.sessions} sessions` : undefined), icon: Eye },
    ],
    queueDepth: raw.components?.queue?.depth ?? 0,
    watcherSessions: raw.components?.watcher?.sessions ?? 0,
    embeddingCoverage: {
      totalChunks: raw.metrics?.embeddingCoverage?.totalChunks ?? 0,
      embeddedChunks: raw.metrics?.embeddingCoverage?.embeddedChunks ?? 0,
      coveragePercent: raw.metrics?.embeddingCoverage?.coveragePercent ?? 0,
    },
  };
};

export default function HealthPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    loadHealthData();
    if (autoRefresh) {
      const interval = setInterval(loadHealthData, 30000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  const loadHealthData = async () => {
    try {
      setIsLoading(true);
      const data = await apiClient.get<RawHealthResponse>('/health');
      setHealth(normalizeHealth(data));
      setLastRefresh(new Date());
    } catch {
      toast.error('Failed to load health data');
    } finally {
      setIsLoading(false);
    }
  };

  const StatusIcon = ({ status }: { status: string }) => {
    if (status === 'ok') return <CheckCircle className="h-4 w-4 text-success-500" />;
    if (status === 'degraded') return <AlertCircle className="h-4 w-4 text-warning-500" />;
    if (status === 'error') return <XCircle className="h-4 w-4 text-error-500" />;
    return <Activity className="h-4 w-4 text-muted-foreground" />;
  };

  const getProgressColor = (pct: number) => {
    if (pct >= 90) return 'bg-success-500';
    if (pct >= 50) return 'bg-warning-500';
    return 'bg-error-500';
  };

  if (isLoading && !health) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-2">
          <Eyebrow prefix>Beacon Health</Eyebrow>
          <h1 className="text-2xl font-normal tracking-tight">
            System status.{' '}
            <span className="text-muted-foreground">[beacon] patrols the services, queues, and stores.</span>
          </h1>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}><CardContent className="p-5"><div className="skeleton h-10 w-10 rounded-lg mb-3" /><div className="skeleton h-6 w-20 mb-1" /><div className="skeleton h-4 w-28" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="py-12 space-y-4">
        <AgentStatusLine agent="beacon" level="block">
          Health feed unreachable. Retry to re-establish the downlink.
        </AgentStatusLine>
        <Button onClick={loadHealthData}><RefreshCw className="h-4 w-4 mr-2" />Retry</Button>
      </div>
    );
  }

  const okCount = health.services.filter((s) => s.status === 'ok').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <Eyebrow prefix>Beacon Health</Eyebrow>
          <h1 className="text-2xl font-normal tracking-tight">
            System status.{' '}
            <span className="text-muted-foreground">[beacon] patrols the services, queues, and stores.</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Auto-refresh</span>
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          </div>
          <Button variant="outline" size="sm" onClick={loadHealthData} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Overall Status */}
      <Card className={`border-l-4 ${health.overallStatus === 'ok' ? 'border-l-success-500' : health.overallStatus === 'degraded' ? 'border-l-warning-500' : 'border-l-error-500'}`}>
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <StatusIcon status={health.overallStatus} />
              <div>
                <h2 className="text-base font-semibold">System Status</h2>
                <p className="text-sm text-muted-foreground">{health.overallStatus === 'ok' ? 'All systems operational' : `Status: ${health.overallStatus}`}</p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold">{okCount}/{health.services.length}</div>
              <p className="text-xs text-muted-foreground">Services healthy</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>Last updated: {lastRefresh ? lastRefresh.toLocaleTimeString() : '...'}</span>
          </div>
        </CardContent>
      </Card>

      {/* Service Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {health.services.map((service) => {
          const Icon = service.icon;
          return (
            <Card key={service.label}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${service.status === 'ok' ? 'bg-success-500/10' : 'bg-error-500/10'}`}>
                      <Icon className={`h-4 w-4 ${service.status === 'ok' ? 'text-success-500' : 'text-error-500'}`} />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium">{service.label}</h3>
                      <p className="text-xs text-muted-foreground">{service.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {service.latency > 0 && (
                      <Badge variant="secondary" className="text-[11px]">{service.latency}ms</Badge>
                    )}
                    <StatusIcon status={service.status} />
                  </div>
                </div>
                {service.detail && (
                  <div className="mt-2 text-xs text-muted-foreground bg-muted rounded px-2 py-1">{service.detail}</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Layers className="h-4 w-4 text-primary-500" />
              <h3 className="text-sm font-semibold">Embedding Coverage</h3>
            </div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">Embedded</span>
              <span className="font-medium">{health.embeddingCoverage.embeddedChunks.toLocaleString()} / {health.embeddingCoverage.totalChunks.toLocaleString()}</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div className={`h-2 rounded-full transition-all ${getProgressColor(health.embeddingCoverage.coveragePercent)}`} style={{ width: `${Math.min(health.embeddingCoverage.coveragePercent, 100)}%` }} />
            </div>
            <div className="text-right mt-1">
              <span className={`text-sm font-semibold ${health.embeddingCoverage.coveragePercent >= 90 ? 'text-success-500' : health.embeddingCoverage.coveragePercent >= 50 ? 'text-warning-500' : 'text-error-500'}`}>
                {health.embeddingCoverage.coveragePercent.toFixed(1)}%
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-4 w-4 text-primary-500" />
              <h3 className="text-sm font-semibold">Queue Status</h3>
            </div>
            <div className="text-center py-1">
              <div className="text-3xl font-bold">{health.queueDepth}</div>
              <p className="text-xs text-muted-foreground mt-0.5">Jobs in queue</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Eye className="h-4 w-4 text-primary-500" />
              <h3 className="text-sm font-semibold">File Watchers</h3>
            </div>
            <div className="text-center py-1">
              <div className="text-3xl font-bold">{health.watcherSessions}</div>
              <p className="text-xs text-muted-foreground mt-0.5">Active sessions</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
