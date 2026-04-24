import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  GitBranch,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Clock,
  FileCode,
  Layers,
  BarChart3,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import { Eyebrow } from '@/components/brand';

interface RepoDetail {
  id: string;
  fullName: string;
  label: string | null;
  branch: string;
  language: string | null;
  framework?: string | null;
  fileCount: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface RepoStatus {
  syncStatus?: string;
  status?: string;
  lastSyncAt?: string;
  syncedAt?: string;
  totalChunks?: number;
  totalFiles?: number;
  lastCommitSha?: string;
}

// IngestStats interface reserved for future use with detailed ingest views

interface GraphSummary {
  nodes: number;
  edges: number;
  hotspots: Array<{ file: string; inDegree: number }>;
  cycles: Array<string[]>;
}

export default function RepoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [graphData, setGraphData] = useState<GraphSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const loadRepo = useCallback(async () => {
    if (!id) return;
    try {
      setIsLoading(true);
      const [repoData, statusData] = await Promise.all([
        apiClient.get<RepoDetail>(`/repos/${id}`),
        apiClient.get<RepoStatus>(`/repos/${id}/status`).catch(() => null),
      ]);
      setRepo(repoData);
      setStatus(statusData);

      // Load graph data in background
      try {
        const [hotspots, cycles, deps] = await Promise.all([
          apiClient.get<Array<{ file: string; inDegree: number }>>(`/graph/hotspots?repoId=${id}`).catch(() => []),
          apiClient.get<Array<string[]>>(`/graph/cycles?repoId=${id}`).catch(() => []),
          apiClient.get<{ nodes: unknown[]; edges: unknown[] }>(`/graph/dependencies?repoId=${id}`).catch(() => ({ nodes: [], edges: [] })),
        ]);
        setGraphData({
          nodes: Array.isArray(deps.nodes) ? deps.nodes.length : 0,
          edges: Array.isArray(deps.edges) ? deps.edges.length : 0,
          hotspots: (hotspots || []).slice(0, 5),
          cycles: (cycles || []).slice(0, 5),
        });
      } catch { /* graph data is optional */ }
    } catch (error) {
      console.error(error);
      toast.error('Failed to load repository');
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { loadRepo(); }, [loadRepo]);

  const handleSync = async () => {
    if (!id) return;
    try {
      setIsSyncing(true);
      await apiClient.post(`/repos/${id}/ingest`);
      toast.success('Sync started');
      // Poll status
      const poll = async () => {
        try {
          const s = await apiClient.get<RepoStatus>(`/repos/${id}/status`);
          setStatus(s);
          const resolved = s.syncStatus ?? s.status;
          if (resolved === 'completed' || resolved === 'indexed' || resolved === 'up_to_date' || resolved === 'failed') {
            setIsSyncing(false);
            if (resolved === 'failed') toast.error('Sync failed');
            else toast.success('Sync completed');
          } else {
            setTimeout(poll, 2000);
          }
        } catch {
          setIsSyncing(false);
        }
      };
      setTimeout(poll, 2000);
    } catch {
      setIsSyncing(false);
      toast.error('Failed to start sync');
    }
  };

  const getSyncStatus = () => {
    const raw = status?.syncStatus ?? status?.status;
    if (raw === 'indexed' || raw === 'completed' || raw === 'up_to_date') return 'completed';
    if (raw === 'not_indexed') return 'pending';
    return raw || 'pending';
  };

  const syncStatus = getSyncStatus();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-8 w-48"></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <div key={i} className="card p-6"><div className="skeleton h-20 w-full"></div></div>)}
        </div>
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="h-12 w-12 text-error-500 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-foreground mb-2">Repository not found</h3>
        <Link to="/repos" className="btn btn-primary mt-4">Back to Repositories</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Link to="/repos" className="p-2 rounded-lg hover:bg-foreground/10 text-muted-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex flex-col gap-1.5">
            <Eyebrow prefix>Rover Outpost</Eyebrow>
            <h1 className="text-2xl font-normal tracking-tight text-foreground">{repo.label || repo.fullName}</h1>
            <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
              <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">
                <ExternalLink className="h-3 w-3" />
                {repo.fullName}
              </a>
              <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{repo.branch}</span>
            </div>
          </div>
        </div>
        <button onClick={handleSync} disabled={isSyncing} className="btn btn-primary flex items-center gap-2">
          {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {isSyncing ? 'Syncing...' : 'Sync Now'}
        </button>
      </div>

      {/* Status + Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card p-5">
          <div className="flex items-center gap-3">
            {syncStatus === 'completed' ? <CheckCircle className="h-5 w-5 text-success-500" /> :
             syncStatus === 'failed' ? <AlertCircle className="h-5 w-5 text-error-500" /> :
             syncStatus === 'syncing' ? <RefreshCw className="h-5 w-5 text-primary-500 animate-spin" /> :
             <Clock className="h-5 w-5 text-muted-foreground" />}
            <div>
              <p className="text-xs text-muted-foreground">Sync Status</p>
              <p className="text-sm font-semibold text-foreground capitalize">{syncStatus}</p>
            </div>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <FileCode className="h-5 w-5 text-primary-500" />
            <div>
              <p className="text-xs text-muted-foreground">Files</p>
              <p className="text-sm font-semibold text-foreground">{(status?.totalFiles ?? repo.fileCount ?? 0).toLocaleString()}</p>
            </div>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <Layers className="h-5 w-5 text-primary-500" />
            <div>
              <p className="text-xs text-muted-foreground">Code Chunks</p>
              <p className="text-sm font-semibold text-foreground">{(status?.totalChunks ?? 0).toLocaleString()}</p>
            </div>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <BarChart3 className="h-5 w-5 text-primary-500" />
            <div>
              <p className="text-xs text-muted-foreground">Graph Nodes</p>
              <p className="text-sm font-semibold text-foreground">{graphData?.nodes?.toLocaleString() ?? '—'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Info */}
        <div className="card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Repository Info</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Full Name</span>
              <span className="text-foreground font-medium">{repo.fullName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Branch</span>
              <span className="text-foreground font-medium">{repo.branch}</span>
            </div>
            {repo.language && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Language</span>
                <span className="bg-foreground/10 text-foreground px-2 py-0.5 rounded text-xs">{repo.language}</span>
              </div>
            )}
            {repo.framework && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Framework</span>
                <span className="bg-primary-100 text-primary-700 px-2 py-0.5 rounded text-xs">{repo.framework}</span>
              </div>
            )}
            {status?.lastSyncAt || status?.syncedAt ? (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Sync</span>
                <span className="text-foreground">{new Date(status.lastSyncAt || status.syncedAt || '').toLocaleString()}</span>
              </div>
            ) : null}
            {status?.lastCommitSha && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Commit</span>
                <code className="text-xs bg-foreground/10 px-1.5 py-0.5 rounded">{status.lastCommitSha.slice(0, 8)}</code>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active</span>
              <span className={repo.isActive ? 'text-success-600' : 'text-error-600'}>{repo.isActive ? 'Yes' : 'No'}</span>
            </div>
          </div>
        </div>

        {/* Graph Intelligence */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Graph Intelligence</h3>
            <Link to="/graph" className="text-xs text-primary-600 hover:text-primary-700">View full graph</Link>
          </div>
          {graphData ? (
            <div className="space-y-4">
              <div className="flex gap-4 text-sm">
                <div><span className="text-muted-foreground">Nodes:</span> <strong>{graphData.nodes}</strong></div>
                <div><span className="text-muted-foreground">Edges:</span> <strong>{graphData.edges}</strong></div>
                <div><span className="text-muted-foreground">Cycles:</span> <strong className={graphData.cycles.length > 0 ? 'text-warning-600' : ''}>{graphData.cycles.length}</strong></div>
              </div>

              {graphData.hotspots.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Top Hotspots (by import count)</h4>
                  <div className="space-y-1">
                    {graphData.hotspots.map((h, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-foreground truncate max-w-[250px] font-mono">{h.file}</span>
                        <span className="text-muted-foreground flex-shrink-0 ml-2">{h.inDegree} imports</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {graphData.cycles.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-warning-600 mb-2">Circular Dependencies</h4>
                  <div className="space-y-1">
                    {graphData.cycles.map((cycle, i) => (
                      <div key={i} className="text-xs text-muted-foreground font-mono truncate">
                        {cycle.join(' → ')}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground text-center py-4">
              No graph data available. Sync the repository first.
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">Quick Actions</h3>
        <div className="flex flex-wrap gap-3">
          <Link to="/chat" className="btn btn-outline text-sm">Ask about this repo</Link>
          <Link to="/pr-reviews" className="btn btn-outline text-sm">Review a PR</Link>
          <Link to="/agents" className="btn btn-outline text-sm">Run Enforcer Scan</Link>
          <Link to={`/graph`} className="btn btn-outline text-sm">View Dependency Graph</Link>
        </div>
      </div>
    </div>
  );
}
