import { useState } from 'react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import { Eyebrow } from '@/components/brand';

export default function OperationsPage() {
  const [repo, setRepo] = useState('demo/codebase');
  const [branch, setBranch] = useState('main');
  const [repoId, setRepoId] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [debugQuery, setDebugQuery] = useState('where is auth guard used');
  const [artifactQuery, setArtifactQuery] = useState('auth');
  const [result, setResult] = useState('');

  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const response = await fn();
      setResult(JSON.stringify(response, null, 2));
      toast.success(`${name} completed`);
    } catch (error) {
      console.error(error);
      toast.error(`${name} failed`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <Eyebrow prefix>Ground Control</Eyebrow>
        <h1 className="text-2xl font-normal tracking-tight">
          Manual overrides.{' '}
          <span className="text-muted-foreground">Trigger ingest, watcher, and debug APIs directly.</span>
        </h1>
      </div>

      <div className="card p-6 space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Ingest + GitHub Test</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch" />
          <input className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)} placeholder="repo UUID (optional)" />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => run('Queue ingest', () => apiClient.post('/ingest/trigger', { repo, branch, repoId: repoId || undefined }))}>
            Queue Ingest
          </button>
          <button className="btn btn-secondary" onClick={() => run('Run sync ingest', () => apiClient.post('/ingest/trigger-sync', { repo, branch, repoId: repoId || undefined }))}>
            Run Sync Ingest
          </button>
          <button className="btn btn-outline" onClick={() => run('Get ingest status', () => apiClient.get(`/ingest/status?repo=${encodeURIComponent(repo)}`))}>
            Ingest Status
          </button>
          <button className="btn btn-outline" onClick={() => run('Run GitHub ingest test', () => apiClient.get(`/ingest/github-test?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`))}>
            GitHub Test
          </button>
        </div>
      </div>

      <div className="card p-6 space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Watcher</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)} placeholder="repo UUID" />
          <input className="input" value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="/absolute/local/path" />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => run('Start watcher', () => apiClient.post('/watcher/start', { repoId, localPath }))} disabled={!repoId || !localPath}>
            Start Watcher
          </button>
          <button className="btn btn-outline" onClick={() => run('Stop watcher', () => apiClient.delete(`/watcher/stop/${encodeURIComponent(repoId)}`))} disabled={!repoId}>
            Stop Watcher
          </button>
          <button className="btn btn-secondary" onClick={() => run('List sessions', () => apiClient.get('/watcher/sessions'))}>
            List Sessions
          </button>
        </div>
      </div>

      <div className="card p-6 space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Agent Operations</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)} placeholder="repo UUID (required)" />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => run('Enforcer scan', () => apiClient.post(`/agent/enforcer/enforce/${repoId}`))} disabled={!repoId}>
            Run Enforcer
          </button>
          <button className="btn btn-secondary" onClick={() => run('Refactor scan', () => apiClient.post('/agent/refactor/scan', { repoId }))} disabled={!repoId}>
            Run Refactor Scan
          </button>
          <button className="btn btn-outline" onClick={() => run('Get violations', () => apiClient.get(`/agent/enforcer/violations/${repoId}`))} disabled={!repoId}>
            Get Violations
          </button>
          <button className="btn btn-outline" onClick={() => run('Get suggestions', () => apiClient.get(`/agent/refactor/suggestions/${repoId}`))} disabled={!repoId}>
            Get Suggestions
          </button>
          <button className="btn btn-outline" onClick={() => run('Agent status', () => apiClient.get('/agent/status'))}>
            Agent Status
          </button>
          <button className="btn btn-outline" onClick={() => run('Ingest stats', () => apiClient.get('/ingest/stats'))}>
            Ingest Stats
          </button>
        </div>
      </div>

      <div className="card p-6 space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Artifacts + Debug Retrieval</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="input" value={artifactQuery} onChange={(e) => setArtifactQuery(e.target.value)} placeholder="artifact search query" />
          <input className="input" value={debugQuery} onChange={(e) => setDebugQuery(e.target.value)} placeholder="debug retrieval query" />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => run('Search artifacts', () => apiClient.get(`/artifacts/search?q=${encodeURIComponent(artifactQuery)}&topK=5`))}>
            Search Artifacts
          </button>
          <button className="btn btn-outline" onClick={() => run('Artifact stats', () => apiClient.get('/artifacts/stats'))}>
            Artifact Stats
          </button>
          <button className="btn btn-secondary" onClick={() => run('Debug retrieval', () => apiClient.post('/debug/retrieval', { query: debugQuery, topK: 8, searchMode: 'hybrid' }))}>
            Debug Retrieval
          </button>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Last Operation Result</h2>
        {result ? (
          <pre className="bg-foreground/10 rounded-lg p-4 text-xs overflow-x-auto">{result}</pre>
        ) : (
          <div className="text-sm text-muted-foreground">Run any operation to inspect API output.</div>
        )}
      </div>
    </div>
  );
}
