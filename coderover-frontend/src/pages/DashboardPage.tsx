import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Database,
  MessageSquare,
  FileText,
  TrendingUp,
  Clock,
  Activity,
  GitBranch,
  Code,
  Zap,
  ArrowRight,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAnalyticsLive } from '../hooks/useAnalyticsLive';
import { useFleetStatus } from '../hooks/useFleetStatus';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Eyebrow, RoverBadge, AgentStatusLine } from '@/components/brand';


interface DashboardStats {
  totalRepos: number;
  totalChunks: number;
  totalArtifacts: number;
  activeSessions: number;
  lastSyncAt: string | null;
  systemHealth: 'healthy' | 'warning' | 'error';
}

interface RecentActivity {
  id: string;
  type: 'ingest' | 'chat' | 'sync';
  message: string;
  timestamp: string;
  status: 'success' | 'warning' | 'error';
}

const statCards = [
  { key: 'totalRepos', label: 'Repositories', icon: Database },
  { key: 'totalChunks', label: 'Code Chunks', icon: Code },
  { key: 'totalArtifacts', label: 'Artifacts', icon: FileText },
  { key: 'activeSessions', label: 'Active Sessions', icon: MessageSquare },
] as const;

export default function DashboardPage() {
  const { snapshot, isLoading, error, lastUpdated } = useAnalyticsLive('7d');
  const { fleet, isLoading: fleetLoading, error: fleetError } = useFleetStatus();

  const stats: DashboardStats = useMemo(
    () => ({
      totalRepos: snapshot?.stats.totalRepos ?? 0,
      totalChunks: snapshot?.stats.totalChunks ?? 0,
      totalArtifacts: snapshot?.stats.totalArtifacts ?? 0,
      activeSessions: snapshot?.stats.activeSessions ?? 0,
      lastSyncAt: snapshot?.stats.lastSyncAt ?? null,
      systemHealth: snapshot?.stats.systemHealth ?? 'healthy',
    }),
    [snapshot],
  );

  const recentActivity: RecentActivity[] = useMemo(
    () =>
      (snapshot?.recentActivity ?? []).map((item) => ({
        id: item.id,
        type: item.type,
        message: item.message,
        timestamp: item.timestamp,
        status: item.status,
      })),
    [snapshot],
  );

  const healthColors: Record<string, string> = {
    healthy: 'text-success-500',
    warning: 'text-warning-500',
    error: 'text-error-500',
  };

  const activityIcons: Record<string, JSX.Element> = {
    ingest: <Database className="h-3.5 w-3.5" />,
    chat: <MessageSquare className="h-3.5 w-3.5" />,
    sync: <GitBranch className="h-3.5 w-3.5" />,
  };

  const statusColors: Record<string, string> = {
    success: 'bg-success-500',
    warning: 'bg-warning-500',
    error: 'bg-error-500',
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <div className="skeleton h-10 w-10 rounded-lg mb-3" />
                <div className="skeleton h-7 w-20 mb-1" />
                <div className="skeleton h-4 w-28" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800">
          Live metrics degraded: {error}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3">
        <Eyebrow prefix>Mission Control</Eyebrow>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-normal tracking-tight">
              The fleet is on station.{' '}
              <span className="text-muted-foreground">Here is what it sees.</span>
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {lastUpdated ? (
                <>[beacon] last downlink {formatDistanceToNow(new Date(lastUpdated), { addSuffix: true })}</>
              ) : (
                <>[beacon] awaiting first downlink</>
              )}
            </p>
          </div>
          <div className={`flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] ${healthColors[stats.systemHealth] || 'text-muted-foreground'}`}>
            <div className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            <span>{stats.systemHealth}</span>
          </div>
        </div>
      </div>

      {/* Fleet Strip */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <Eyebrow prefix>The Fleet</Eyebrow>
          {fleetError && (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              [downlink] lost · retrying
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {fleet.map((rover) => (
            <RoverBadge
              key={rover.name}
              unit={rover.unit}
              name={rover.name}
              role={rover.role}
              status={fleetLoading ? 'pending' : rover.status}
            >
              {fleetLoading ? '[downlink] syncing…' : rover.note}
            </RoverBadge>
          ))}
        </div>
      </section>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map(({ key, label, icon: Icon }) => (
          <Card key={key} className="transition-colors hover:bg-foreground/[0.02]">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
                  <p className="mt-2 text-2xl font-normal tabular-nums text-foreground">
                    {(stats[key] as number).toLocaleString()}
                  </p>
                </div>
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Activity + Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Activity */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Recent Activity</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentActivity.length === 0 ? (
              <div className="py-4">
                <AgentStatusLine agent="beacon" level="pending">
                  No downlinks yet. The fleet is armed and watching.
                </AgentStatusLine>
              </div>
            ) : (
              <div className="space-y-3">
                {recentActivity.map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <div className={`h-1.5 w-1.5 rounded-full ${statusColors[item.status] || 'bg-muted-foreground'}`} />
                      <span className="text-muted-foreground">
                        {activityIcons[item.type] || <Activity className="h-3.5 w-3.5" />}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{item.message}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Quick Actions</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="pt-0 space-y-1">
            {[
              { to: '/chat', icon: MessageSquare, title: 'Ask [archive]', desc: 'Query the decision memory' },
              { to: '/repos', icon: Database, title: 'Add repository', desc: 'Index a new codebase' },
              { to: '/health', icon: TrendingUp, title: 'System health', desc: '[beacon] status & metrics' },
            ].map(({ to, icon: Icon, title, desc }) => (
              <Link
                key={to}
                to={to}
                className="flex items-center gap-3 p-2.5 hover:bg-foreground/[0.03] transition-colors group"
              >
                <div className="flex h-9 w-9 items-center justify-center border border-border">
                  <Icon className="h-4 w-4 text-foreground" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{title}</p>
                  <p className="font-mono text-xs text-muted-foreground">{desc}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            ))}

            {stats.lastSyncAt && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted p-2.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Last sync: {formatDistanceToNow(new Date(stats.lastSyncAt), { addSuffix: true })}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
