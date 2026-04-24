import { useEffect, useMemo, useState } from 'react';
import { FileText, Search, RefreshCw, X, ExternalLink, Code, FileJson, Cloud, BookOpen, Hexagon, Box } from 'lucide-react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import Pagination, { usePagination } from '../components/Pagination';
import { Eyebrow } from '@/components/brand';

type ArtifactType = 'schema' | 'openapi' | 'terraform' | 'markdown' | 'graphql' | 'proto' | 'other';

interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  path?: string;
  repoId?: string;
  createdAt?: string;
  content?: string;
}

const typeConfig: Record<ArtifactType, { icon: typeof FileText; color: string }> = {
  openapi: { icon: FileJson, color: 'text-success-600 bg-success-50' },
  terraform: { icon: Cloud, color: 'text-purple-600 bg-purple-50' },
  markdown: { icon: BookOpen, color: 'text-info-600 bg-info-50' },
  graphql: { icon: Hexagon, color: 'text-pink-600 bg-pink-50' },
  schema: { icon: Code, color: 'text-warning-600 bg-warning-50' },
  proto: { icon: Box, color: 'text-muted-foreground bg-foreground/5' },
  other: { icon: FileText, color: 'text-muted-foreground bg-foreground/5' },
};

const normalizeArtifact = (value: Record<string, unknown>): Artifact | null => {
  const id = typeof value.id === 'string' ? value.id : null;
  if (!id) return null;

  const typeRaw = value.artifactType;
  const type: ArtifactType =
    typeRaw === 'schema' || typeRaw === 'openapi' || typeRaw === 'terraform' ||
    typeRaw === 'markdown' || typeRaw === 'graphql' || typeRaw === 'proto'
      ? typeRaw : 'other';

  const path = typeof value.filePath === 'string' ? value.filePath : typeof value.path === 'string' ? value.path : undefined;
  const repoId = typeof value.repoId === 'string' ? value.repoId : undefined;
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : undefined;
  const content = typeof value.content === 'string' ? value.content : typeof value.rawText === 'string' ? value.rawText : undefined;

  const titleFromMetadata =
    typeof value.metadata === 'object' && value.metadata
      ? typeof (value.metadata as Record<string, unknown>).title === 'string'
        ? ((value.metadata as Record<string, unknown>).title as string) : null
      : null;
  const title = titleFromMetadata || path || 'Untitled';

  return { id, type, title, path, repoId, createdAt, content };
};

function ArtifactDetailModal({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(artifact.content || null);
  const [loading, setLoading] = useState(!artifact.content);

  useEffect(() => {
    if (artifact.content) return;
    const load = async () => {
      try {
        setLoading(true);
        const results = await apiClient.get<Record<string, unknown>[]>(
          `/artifacts/search?q=${encodeURIComponent(artifact.title)}&limit=1`,
        );
        if (results.length > 0) {
          const raw = results[0];
          const text = typeof raw.content === 'string' ? raw.content : typeof raw.rawText === 'string' ? raw.rawText : null;
          setContent(text);
        }
      } catch {
        setContent(null);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [artifact]);

  const cfg = typeConfig[artifact.type] || typeConfig.other;
  const Icon = cfg.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-xl shadow-2xl max-w-3xl w-full max-h-[80vh] flex flex-col border border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2 rounded-lg ${cfg.color}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-foreground truncate">{artifact.title}</h3>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                <span className="capitalize">{artifact.type}</span>
                {artifact.repoId && <span>Repo: {artifact.repoId}</span>}
                {artifact.createdAt && <span>{new Date(artifact.createdAt).toLocaleDateString()}</span>}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-foreground/10 text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Path */}
        {artifact.path && (
          <div className="px-6 py-2 bg-foreground/5 border-b border-border text-xs font-mono text-muted-foreground flex items-center gap-2">
            <ExternalLink className="h-3 w-3" />
            {artifact.path}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="space-y-2">
              <div className="skeleton h-4 w-full"></div>
              <div className="skeleton h-4 w-3/4"></div>
              <div className="skeleton h-4 w-5/6"></div>
            </div>
          ) : content ? (
            <pre className="text-xs font-mono text-foreground whitespace-pre-wrap leading-relaxed">{content}</pre>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Content not available. Try searching for this artifact in the Operations page.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter((a) =>
      a.title.toLowerCase().includes(q) ||
      (a.path ? a.path.toLowerCase().includes(q) : false) ||
      a.type.toLowerCase().includes(q)
    );
  }, [artifacts, query]);

  const { getPage, totalItems, pageSize } = usePagination(filtered, 12);
  const pageItems = getPage(page);

  // Reset page when filter changes
  useEffect(() => { setPage(1); }, [query]);

  const loadArtifacts = async () => {
    try {
      setIsLoading(true);
      const data = await apiClient.get<Record<string, unknown>[]>('/artifacts/list');
      const normalized = data.map(normalizeArtifact).filter((v): v is Artifact => Boolean(v));
      setArtifacts(normalized);
    } catch (error) {
      console.error('Failed to load artifacts:', error);
      toast.error('Failed to load artifacts');
      setArtifacts([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadArtifacts(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <Eyebrow prefix>Archive · Extracted Context</Eyebrow>
          <h1 className="text-2xl font-normal tracking-tight">
            Browse every artifact.{' '}
            <span className="text-muted-foreground">[archive] keeps {artifacts.length} on record.</span>
          </h1>
        </div>
        <button onClick={loadArtifacts} className="btn btn-outline flex items-center space-x-2" disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="card p-4">
        <div className="flex items-center space-x-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="input flex-1"
            placeholder="Search artifacts by title, path, or type..."
          />
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="card p-6">
              <div className="skeleton h-6 w-40 mb-3"></div>
              <div className="skeleton h-4 w-64 mb-2"></div>
              <div className="skeleton h-4 w-32"></div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-2">No artifacts found</h3>
          <p className="text-muted-foreground">Try adjusting your search or ingest a repository to generate artifacts.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {pageItems.map((artifact) => {
              const cfg = typeConfig[artifact.type] || typeConfig.other;
              const Icon = cfg.icon;
              return (
                <button
                  key={artifact.id}
                  onClick={() => setSelectedArtifact(artifact)}
                  className="card p-6 text-left hover:shadow-md hover:border-primary-200 transition-all"
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-foreground truncate">{artifact.title}</h3>
                      <p className="text-xs text-muted-foreground mt-1 capitalize">{artifact.type}</p>
                    </div>
                    <div className={`p-1.5 rounded-lg flex-shrink-0 ${cfg.color}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                  </div>
                  {artifact.path && <p className="text-xs text-muted-foreground mt-3 truncate font-mono">{artifact.path}</p>}
                  <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{artifact.repoId ? `Repo: ${artifact.repoId}` : '—'}</span>
                    <span>{artifact.createdAt ? new Date(artifact.createdAt).toLocaleDateString() : '—'}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <Pagination currentPage={page} totalItems={totalItems} pageSize={pageSize} onPageChange={setPage} />
        </>
      )}

      {selectedArtifact && (
        <ArtifactDetailModal artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />
      )}
    </div>
  );
}
