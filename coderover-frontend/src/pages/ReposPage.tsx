import { useState, useEffect } from 'react';
import { RepoCreateDialog } from '../components/repos/RepoCreateDialog';
import { Link } from 'react-router-dom';
import {
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  GitBranch,
  Clock,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  Database,
  X,
  AlertOctagon,
} from 'lucide-react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import { Eyebrow } from '@/components/brand';

interface Repository {
  id: string;
  fullName: string;
  label: string;
  branch: string;
  language?: string;
  framework?: string;
  lastSyncAt?: string;
  syncStatus: 'pending' | 'syncing' | 'completed' | 'failed';
  totalChunks?: number;
  isActive: boolean;
}

interface RepoApiResponse {
  id: string;
  fullName: string;
  label: string | null;
  branch: string;
  language: string | null;
  fileCount: number;
  isActive: boolean;
}

const normalizeRepo = (repo: RepoApiResponse): Repository => ({
  id: repo.id,
  fullName: repo.fullName,
  label: repo.label ?? repo.fullName,
  branch: repo.branch,
  language: repo.language ?? undefined,
  syncStatus: 'pending',
  totalChunks: repo.fileCount,
  isActive: repo.isActive,
});

export default function ReposPage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingRepoId, setEditingRepoId] = useState('');
  const [syncingRepos, setSyncingRepos] = useState<Set<string>>(new Set());

  const [newRepo, setNewRepo] = useState({
    repoUrl: '',
    label: '',
    branch: '',
    githubToken: '',
  });
  const [editRepo, setEditRepo] = useState({
    label: '',
    branch: '',
    githubToken: '',
  });

  useEffect(() => {
    loadRepositories();
  }, []);

  const isSyncStatus = (value: unknown): value is Repository['syncStatus'] =>
    value === 'pending' || value === 'syncing' || value === 'completed' || value === 'failed';

  const mapBackendStatus = (value: unknown): Repository['syncStatus'] => {
    if (isSyncStatus(value)) return value;
    if (value === 'indexed' || value === 'completed' || value === 'up_to_date') return 'completed';
    if (value === 'not_indexed') return 'pending';
    return 'pending';
  };

  const loadRepositories = async () => {
    try {
      setIsLoading(true);
      const data = await apiClient.get<RepoApiResponse[]>('/repos');
      setRepositories(data.map(normalizeRepo));
    } catch (error) {
      console.error('Failed to load repositories:', error);
      toast.error('Failed to load repositories');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const payload = {
        repoUrl: newRepo.repoUrl,
        label: newRepo.label || undefined,
        branch: newRepo.branch.trim() || undefined,
        githubToken: newRepo.githubToken.trim() || undefined,
      };
      const response = await apiClient.post<RepoApiResponse>('/repos', payload);
      setRepositories(prev => [...prev, normalizeRepo(response)]);
      setShowAddModal(false);
      setNewRepo({ repoUrl: '', label: '', branch: '', githubToken: '' });
      toast.success('Repository added successfully');
    } catch (error) {
      console.error('Failed to add repository:', error);
      toast.error('Failed to add repository');
    }
  };

  const openEditModal = (repo: Repository) => {
    setEditingRepoId(repo.id);
    setEditRepo({
      label: repo.label === repo.fullName ? '' : repo.label,
      branch: repo.branch,
      githubToken: '',
    });
    setShowEditModal(true);
  };

  const handleUpdateRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRepoId) return;

    try {
      const payload = {
        label: editRepo.label,
        branch: editRepo.branch,
        githubToken: editRepo.githubToken.trim() || undefined,
      };
      const response = await apiClient.put<RepoApiResponse>(`/repos/${editingRepoId}`, payload);
      setRepositories(prev => prev.map((repo) => (repo.id === editingRepoId ? normalizeRepo(response) : repo)));
      setShowEditModal(false);
      setEditingRepoId('');
      setEditRepo({ label: '', branch: '', githubToken: '' });
      toast.success('Repository updated successfully');
    } catch (error) {
      console.error('Failed to update repository:', error);
      toast.error('Failed to update repository');
    }
  };

  const handleSyncRepository = async (repoId: string) => {
    try {
      setSyncingRepos(prev => new Set([...prev, repoId]));
      
      await apiClient.post(`/repos/${repoId}/ingest`);
      setRepositories(prev => prev.map(repo =>
        repo.id === repoId ? { ...repo, syncStatus: 'syncing' } : repo
      ));
      toast.success('Repository sync started');
      
      // Poll for status updates
      const checkStatus = async () => {
        try {
          const statusResponse = await apiClient.get<Record<string, unknown>>(`/repos/${repoId}/status`);
          const syncStatusValue = mapBackendStatus(statusResponse.syncStatus ?? statusResponse.status);
          const lastSyncAtValue =
            typeof statusResponse.lastSyncAt === 'string'
              ? statusResponse.lastSyncAt
              : typeof statusResponse.syncedAt === 'string'
                ? statusResponse.syncedAt
                : undefined;
          
          setRepositories(prev => prev.map(repo => 
            repo.id === repoId 
              ? { ...repo, syncStatus: syncStatusValue, lastSyncAt: lastSyncAtValue }
              : repo
          ));
          
          if (syncStatusValue === 'completed' || syncStatusValue === 'failed') {
            setSyncingRepos(prev => {
              const newSet = new Set(prev);
              newSet.delete(repoId);
              return newSet;
            });
            
            if (syncStatusValue === 'completed') {
              toast.success('Repository sync completed');
            } else {
              toast.error('Repository sync failed');
            }
          } else {
            // Continue polling
            setTimeout(checkStatus, 2000);
          }
        } catch (error) {
          console.error('Failed to check sync status:', error);
          setSyncingRepos(prev => {
            const newSet = new Set(prev);
            newSet.delete(repoId);
            return newSet;
          });
        }
      };
      
      setTimeout(checkStatus, 2000);
      
    } catch (error) {
      console.error('Failed to sync repository:', error);
      toast.error('Failed to start repository sync');
      setSyncingRepos(prev => {
        const newSet = new Set(prev);
        newSet.delete(repoId);
        return newSet;
      });
    }
  };

  const handleDeleteRepository = async (repoId: string) => {
    if (!confirm('Are you sure you want to deactivate this repository?')) {
      return;
    }
    try {
      await apiClient.delete(`/repos/${repoId}`);
      setRepositories(prev => prev.filter(repo => repo.id !== repoId));
      toast.success('Repository deactivated');
    } catch (error) {
      console.error('Failed to delete repository:', error);
      toast.error('Failed to delete repository');
    }
  };

  const handleHardDelete = async (repoId: string) => {
    if (!confirm('PERMANENT DELETE: This will remove the repository and ALL indexed data (chunks, artifacts, graph). This cannot be undone. Continue?')) {
      return;
    }
    try {
      await apiClient.delete(`/repos/${repoId}/hard`);
      setRepositories(prev => prev.filter(repo => repo.id !== repoId));
      toast.success('Repository permanently deleted');
    } catch (error) {
      console.error('Failed to hard delete repository:', error);
      toast.error('Failed to permanently delete repository');
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-success-500" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-error-500" />;
      case 'syncing':
        return <RefreshCw className="h-4 w-4 text-primary-500 animate-spin" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'text-success-600 bg-success-50';
      case 'failed':
        return 'text-error-600 bg-error-50';
      case 'syncing':
        return 'text-primary-600 bg-primary-50';
      default:
        return 'text-muted-foreground bg-foreground/5';
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Eyebrow prefix>Fleet Registry</Eyebrow>
            <h1 className="text-2xl font-normal tracking-tight">
              Every codebase under patrol.{' '}
              <span className="text-muted-foreground">Add a repository and the fleet lands.</span>
            </h1>
          </div>
          <div className="skeleton h-10 w-32"></div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="card p-6">
              <div className="skeleton h-6 w-32 mb-4"></div>
              <div className="skeleton h-4 w-48 mb-2"></div>
              <div className="skeleton h-4 w-32 mb-4"></div>
              <div className="flex space-x-2">
                <div className="skeleton h-8 w-16"></div>
                <div className="skeleton h-8 w-16"></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Eyebrow prefix>Fleet Registry</Eyebrow>
          <h1 className="text-2xl font-normal tracking-tight mt-2">
            Every codebase under patrol.{' '}
            <span className="text-muted-foreground">Add a repository and the fleet lands.</span>
          </h1>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="btn btn-primary flex items-center space-x-2"
        >
          <Plus className="h-4 w-4" />
          <span>Add Repository</span>
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="card p-6">
          <div className="flex items-center">
            <div className="p-2 bg-primary-100 rounded-lg">
              <Database className="h-6 w-6 text-primary-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-muted-foreground">Total Repositories</p>
              <p className="text-2xl font-bold text-foreground">{repositories.length}</p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center">
            <div className="p-2 bg-success-100 rounded-lg">
              <CheckCircle className="h-6 w-6 text-success-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-muted-foreground">Synced</p>
              <p className="text-2xl font-bold text-foreground">
                {repositories.filter(r => r.syncStatus === 'completed').length}
              </p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center">
            <div className="p-2 bg-warning-100 rounded-lg">
              <RefreshCw className="h-6 w-6 text-warning-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-muted-foreground">Pending Sync</p>
              <p className="text-2xl font-bold text-foreground">
                {repositories.filter(r => r.syncStatus === 'pending').length}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Repository list */}
      <div className="card">
        <div className="p-6 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Your Repositories</h2>
        </div>
        
        <div className="divide-y divide-border">
          {repositories.map((repo) => (
            <div key={repo.id} className="p-6 hover:bg-foreground/5 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-3">
                    <Link to={`/repos/${repo.id}`} className="text-lg font-semibold text-foreground hover:text-primary-600 transition-colors">{repo.label}</Link>
                    <span className={`inline-flex items-center space-x-1 px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(repo.syncStatus)}`}>
                      {getStatusIcon(repo.syncStatus)}
                      <span className="capitalize">{repo.syncStatus}</span>
                    </span>
                  </div>
                  
                  <div className="mt-2 space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center">
                      <GitBranch className="h-4 w-4 mr-1" />
                      {repo.branch}
                    </p>
                    
                    <p className="text-sm text-muted-foreground flex items-center">
                      <ExternalLink className="h-4 w-4 mr-1" />
                      <a
                        href={`https://github.com/${repo.fullName}`}
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="hover:text-primary-600"
                      >
                        {repo.fullName}
                      </a>
                    </p>
                    
                    {repo.lastSyncAt && (
                      <p className="text-sm text-muted-foreground flex items-center">
                        <Clock className="h-4 w-4 mr-1" />
                        Last synced: {new Date(repo.lastSyncAt).toLocaleString()}
                      </p>
                    )}
                    
                    {repo.totalChunks && (
                      <p className="text-sm text-muted-foreground">
                        {repo.totalChunks.toLocaleString()} code chunks indexed
                      </p>
                    )}
                    
                    {repo.language && (
                      <div className="flex items-center space-x-2 mt-2">
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-foreground/10 text-foreground">
                          {repo.language}
                        </span>
                        {repo.framework && (
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-primary-100 text-primary-700">
                            {repo.framework}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleSyncRepository(repo.id)}
                    disabled={syncingRepos.has(repo.id) || repo.syncStatus === 'syncing'}
                    className="btn btn-outline flex items-center space-x-1"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncingRepos.has(repo.id) ? 'animate-spin' : ''}`} />
                    <span>Sync</span>
                  </button>

                  <button
                    onClick={() => openEditModal(repo)}
                    className="btn btn-outline flex items-center space-x-1"
                  >
                    <Pencil className="h-4 w-4" />
                    <span>Edit</span>
                  </button>
                  
                  <button
                    onClick={() => handleDeleteRepository(repo.id)}
                    className="btn btn-ghost text-error-600 hover:text-error-700 hover:bg-error-50"
                    title="Deactivate"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleHardDelete(repo.id)}
                    className="btn btn-ghost text-error-600 hover:text-error-700 hover:bg-error-50"
                    title="Permanent delete (all data)"
                  >
                    <AlertOctagon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
          
          {repositories.length === 0 && (
            <div className="p-12 text-center">
              <Database className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">No repositories yet</h3>
              <p className="text-muted-foreground mb-6">
                Add your first repository to start indexing your codebase and enable AI-powered search.
              </p>
              <button
                onClick={() => setShowAddModal(true)}
                className="btn btn-primary"
              >
                Add Repository
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Phase 10 (2026-04-16): Replaced the legacy inline URL+PAT modal
          with a GitHub-OAuth-backed picker. The new dialog still offers
          manual URL+PAT entry as an "Advanced" tab. Legacy modal markup
          below is kept dead behind `{false && ...}` so git blame can
          find it quickly if a diff is needed; safe to delete next
          release. */}
      <RepoCreateDialog
        open={showAddModal}
        onOpenChange={(o) => {
          setShowAddModal(o);
          if (!o) loadRepositories();
        }}
      />

      {false && showAddModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-black bg-opacity-50" onClick={() => setShowAddModal(false)} />
            
            <div className="relative bg-card rounded-lg shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-foreground">Add Repository</h3>
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="p-1 rounded hover:bg-foreground/10"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                
                <form onSubmit={handleAddRepository} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      Repository URL
                    </label>
                    <input
                      type="url"
                      value={newRepo.repoUrl}
                      onChange={(e) => setNewRepo(prev => ({ ...prev, repoUrl: e.target.value }))}
                      className="input"
                      placeholder="https://github.com/owner/repo"
                      required
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      Label
                    </label>
                    <input
                      type="text"
                      value={newRepo.label}
                      onChange={(e) => setNewRepo(prev => ({ ...prev, label: e.target.value }))}
                      className="input"
                      placeholder="My Repository"
                      required
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      Branch
                    </label>
                    <input
                      type="text"
                      value={newRepo.branch}
                      onChange={(e) => setNewRepo(prev => ({ ...prev, branch: e.target.value }))}
                      className="input"
                      placeholder="main"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      GitHub Token (optional)
                    </label>
                    <input
                      type="password"
                      value={newRepo.githubToken}
                      onChange={(e) => setNewRepo(prev => ({ ...prev, githubToken: e.target.value }))}
                      className="input"
                      placeholder="ghp_..."
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Required for private repositories
                    </p>
                  </div>
                  
                  <div className="flex space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowAddModal(false)}
                      className="flex-1 btn btn-secondary"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="flex-1 btn btn-primary"
                    >
                      Add Repository
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}

      {showEditModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-black bg-opacity-50" onClick={() => setShowEditModal(false)} />

            <div className="relative bg-card rounded-lg shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-foreground">Edit Repository</h3>
                  <button
                    onClick={() => setShowEditModal(false)}
                    className="p-1 rounded hover:bg-foreground/10"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                <form onSubmit={handleUpdateRepository} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      Label
                    </label>
                    <input
                      type="text"
                      value={editRepo.label}
                      onChange={(e) => setEditRepo(prev => ({ ...prev, label: e.target.value }))}
                      className="input"
                      placeholder="Repository label"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      Branch
                    </label>
                    <input
                      type="text"
                      value={editRepo.branch}
                      onChange={(e) => setEditRepo(prev => ({ ...prev, branch: e.target.value }))}
                      className="input"
                      placeholder="main"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      GitHub Token (optional)
                    </label>
                    <input
                      type="password"
                      value={editRepo.githubToken}
                      onChange={(e) => setEditRepo(prev => ({ ...prev, githubToken: e.target.value }))}
                      className="input"
                      placeholder="Leave empty to keep unchanged"
                    />
                  </div>

                  <div className="flex space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowEditModal(false)}
                      className="flex-1 btn btn-secondary"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="flex-1 btn btn-primary"
                    >
                      Save Changes
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
