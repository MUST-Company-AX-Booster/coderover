import { useMemo, useState } from 'react';
import { 
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  LineChart,
  Line,
  PieChart, 
  Pie, 
  Cell,
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer 
} from 'recharts';
import { TrendingUp, Users, MessageSquare, Database, Calendar, Filter } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAnalyticsLive } from '../hooks/useAnalyticsLive';
import { Eyebrow } from '@/components/brand';

interface AnalyticsData {
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
}

// Brand palette (DESIGN.md): accent green / destructive coral / silver / bone
// ramp. Recharts needs hex so we can't use CSS tokens directly.
const BRAND_ACCENT = '#9FE0B4';       // signal green
const BRAND_CORAL = '#E89D9D';        // destructive coral
const BRAND_SILVER = '#8C8C87';       // silver / muted
const BRAND_BONE = '#EDEBE5';         // bone
const BRAND_MUTED = '#6B6B66';        // deeper silver
const BRAND_GRID = 'rgba(237, 235, 229, 0.08)';   // bone at 8% alpha
const BRAND_AXIS = '#8C8C87';

const COLORS = [BRAND_ACCENT, BRAND_CORAL, BRAND_SILVER, BRAND_BONE, BRAND_MUTED, '#5A5A55'];

export default function AnalyticsPage() {
  const [timeRange, setTimeRange] = useState('7d');
  const { snapshot, isLoading, error, lastUpdated } = useAnalyticsLive(timeRange);
  const analytics: AnalyticsData = useMemo(
    () => ({
      dailyUsage: snapshot?.dailyUsage ?? [],
      repoStats: snapshot?.repoStats ?? [],
      languageDistribution: snapshot?.languageDistribution ?? [],
      topQueries: snapshot?.topQueries ?? [],
      responseTimeSeries: snapshot?.responseTimeSeries ?? [],
      responseTimeByRepo: snapshot?.responseTimeByRepo ?? [],
      systemMetrics: snapshot?.systemMetrics ?? {
        totalChats: 0,
        totalSearches: 0,
        activeUsers: 0,
        avgResponseTime: 0,
        responseTimeTrendDelta: 0,
        responseTimePercentiles: {
          p50: 0,
          p90: 0,
          p95: 0,
          p99: 0,
        },
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        totalChunks: 0,
        totalArtifacts: 0,
      },
    }),
    [snapshot],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-2">
            <Eyebrow prefix>Beacon Analytics</Eyebrow>
            <h1 className="text-2xl font-normal tracking-tight">
              The signals.{' '}
              <span className="text-muted-foreground">What the fleet measures week over week.</span>
            </h1>
          </div>
          <div className="skeleton h-10 w-32"></div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="card p-6">
              <div className="skeleton h-12 w-12 rounded-lg mb-4"></div>
              <div className="skeleton h-8 w-24 mb-2"></div>
              <div className="skeleton h-4 w-32"></div>
            </div>
          ))}
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card p-6">
            <div className="skeleton h-6 w-32 mb-4"></div>
            <div className="skeleton h-64 w-full"></div>
          </div>
          
          <div className="card p-6">
            <div className="skeleton h-6 w-32 mb-4"></div>
            <div className="skeleton h-64 w-full"></div>
          </div>
        </div>
      </div>
    );
  }

  const formatMs = (value: number) => `${Math.round(value)}ms`;
  const trendDelta = analytics.systemMetrics.responseTimeTrendDelta;
  const trendLabel = trendDelta === 0 ? 'No change' : `${trendDelta > 0 ? '+' : ''}${trendDelta.toFixed(1)}%`;
  const percentileMetrics = analytics.systemMetrics.responseTimePercentiles;

  return (
    <div className="space-y-6">
      {error && (
        <div className="card p-4 border border-warning-200 bg-warning-50 text-warning-800 text-sm">
          Live analytics degraded: {error}
        </div>
      )}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <Eyebrow prefix>Beacon Analytics</Eyebrow>
          <h1 className="text-2xl font-normal tracking-tight">
            The signals.{' '}
            <span className="text-muted-foreground">What the fleet measures week over week.</span>
          </h1>
          {lastUpdated && (
            <p className="font-mono text-xs text-muted-foreground">
              [beacon] last downlink {formatDistanceToNow(new Date(lastUpdated), { addSuffix: true })}
            </p>
          )}
        </div>
        
        <div className="flex items-center space-x-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className="input text-sm"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="card p-6">
          <div className="flex items-center">
            <div className="p-2 border border-border">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-muted-foreground">Total Chats</p>
              <p className="text-2xl font-bold text-foreground">{analytics.systemMetrics.totalChats.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground flex items-center mt-1">
                <TrendingUp className="h-3 w-3 mr-1" />
                Live metric
              </p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center">
            <div className="p-2 border border-border">
              <Database className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-muted-foreground">Total Searches</p>
              <p className="text-2xl font-bold text-foreground">{analytics.systemMetrics.totalSearches.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground flex items-center mt-1">
                <TrendingUp className="h-3 w-3 mr-1" />
                Live metric
              </p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center">
            <div className="p-2 border border-border">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-muted-foreground">Active Users</p>
              <p className="text-2xl font-bold text-foreground">{analytics.systemMetrics.activeUsers}</p>
              <p className="text-xs text-muted-foreground text-sm mt-1">Updated from active sessions</p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center">
            <div className="p-2 border border-border">
              <Calendar className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-muted-foreground">Avg Response Time</p>
              <p className="text-2xl font-bold text-foreground">{formatMs(analytics.systemMetrics.avgResponseTime)}</p>
              <p className="text-xs text-muted-foreground flex items-center mt-1">
                <TrendingUp className="h-3 w-3 mr-1" />
                {trendLabel} vs previous window
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">Response Time Percentiles</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={analytics.responseTimeSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={BRAND_GRID} />
              <XAxis dataKey="date" stroke={BRAND_AXIS} fontSize={12} />
              <YAxis stroke={BRAND_AXIS} fontSize={12} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="p50Ms" stroke={BRAND_SILVER} strokeWidth={2} dot={false} name="P50 (ms)" />
              <Line type="monotone" dataKey="p90Ms" stroke={BRAND_ACCENT} strokeWidth={2} dot={false} name="P90 (ms)" />
              <Line type="monotone" dataKey="p99Ms" stroke={BRAND_CORAL} strokeWidth={2} dot={false} name="P99 (ms)" />
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-muted-foreground mt-3">
            Current percentiles: P50 {formatMs(percentileMetrics.p50)} · P90 {formatMs(percentileMetrics.p90)} · P95 {formatMs(percentileMetrics.p95)} · P99 {formatMs(percentileMetrics.p99)}
          </p>
        </div>

        <div className="card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">Token Usage</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg bg-foreground/5 p-3">
              <p className="text-xs text-muted-foreground">Prompt</p>
              <p className="text-lg font-semibold text-foreground">
                {analytics.systemMetrics.tokenUsage.promptTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg bg-foreground/5 p-3">
              <p className="text-xs text-muted-foreground">Completion</p>
              <p className="text-lg font-semibold text-foreground">
                {analytics.systemMetrics.tokenUsage.completionTokens.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg bg-foreground/5 p-3">
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-lg font-semibold text-foreground">
                {analytics.systemMetrics.tokenUsage.totalTokens.toLocaleString()}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">Summed from recorded AI requests in selected range</p>
        </div>

        <div className="card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">Daily Usage</h3>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={analytics.dailyUsage}>
              <CartesianGrid strokeDasharray="3 3" stroke={BRAND_GRID} />
              <XAxis dataKey="date" stroke={BRAND_AXIS} fontSize={12} />
              <YAxis stroke={BRAND_AXIS} fontSize={12} />
              <Tooltip />
              <Legend />
              <Area type="monotone" dataKey="chats" stackId="1" stroke={BRAND_ACCENT} fill={BRAND_ACCENT} fillOpacity={0.4} name="Chats" />
              <Area type="monotone" dataKey="searches" stackId="1" stroke={BRAND_SILVER} fill={BRAND_SILVER} fillOpacity={0.35} name="Searches" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">Language Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={analytics.languageDistribution}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ language, percentage }) => `${language} (${percentage}%)`}
                outerRadius={80}
                fill={BRAND_ACCENT}
                dataKey="count"
              >
                {analytics.languageDistribution.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">Repository Statistics</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={analytics.repoStats}>
              <CartesianGrid strokeDasharray="3 3" stroke={BRAND_GRID} />
              <XAxis dataKey="name" stroke={BRAND_AXIS} fontSize={12} />
              <YAxis stroke={BRAND_AXIS} fontSize={12} />
              <Tooltip />
              <Legend />
              <Bar dataKey="chunks" fill={BRAND_ACCENT} name="Code Chunks" />
              <Bar dataKey="artifacts" fill={BRAND_SILVER} name="Artifacts" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">Repository Latency (P90 vs Average)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={analytics.responseTimeByRepo}>
              <CartesianGrid strokeDasharray="3 3" stroke={BRAND_GRID} />
              <XAxis dataKey="repo" stroke={BRAND_AXIS} fontSize={12} />
              <YAxis stroke={BRAND_AXIS} fontSize={12} />
              <Tooltip />
              <Legend />
              <Bar dataKey="avgMs" fill={BRAND_ACCENT} name="Avg (ms)" />
              <Bar dataKey="p90Ms" fill={BRAND_CORAL} name="P90 (ms)" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-6">
          <h3 className="text-lg font-semibold text-foreground mb-4">Top Search Queries</h3>
          <div className="space-y-3">
            {analytics.topQueries.length === 0 && (
              <div className="text-sm text-muted-foreground">No query history available yet.</div>
            )}
            {analytics.topQueries.map((query, index) => (
              <div key={index} className="flex items-center justify-between p-3 bg-foreground/5 rounded-lg">
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-semibold text-muted-foreground w-6">#{index + 1}</span>
                  <div>
                    <p className="text-sm font-medium text-foreground">{query.query}</p>
                    <p className="text-xs text-muted-foreground">{query.category}</p>
                  </div>
                </div>
                <span className="text-sm font-semibold text-primary-600">{query.frequency}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
