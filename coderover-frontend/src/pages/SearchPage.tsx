import { useState, useCallback } from 'react';
import { Search, FileText, Code, Filter, Loader2, X } from 'lucide-react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Eyebrow, AgentStatusLine } from '@/components/brand';

interface SearchResult {
  filePath: string;
  moduleName?: string;
  lineStart?: number;
  lineEnd?: number;
  similarity?: number;
  language?: string;
  framework?: string;
}

interface SearchResponse {
  query: string;
  mode: string;
  fallbackUsed: boolean;
  resultsFound: number;
  results: SearchResult[];
}

interface ArtifactResult {
  id: string;
  type: string;
  name: string;
  content?: string;
  repoId?: string;
  similarity?: number;
}

type SearchMode = 'code' | 'artifacts';

const LANGUAGES = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'C#', 'Ruby'];
const SEARCH_MODES = ['auto', 'semantic', 'bm25', 'hybrid'] as const;

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('code');
  const [codeSearchMode, setCodeSearchMode] = useState<string>('auto');
  const [languageFilter, setLanguageFilter] = useState<string>('');
  const [topK, setTopK] = useState(10);
  const [isSearching, setIsSearching] = useState(false);
  const [codeResults, setCodeResults] = useState<SearchResult[]>([]);
  const [artifactResults, setArtifactResults] = useState<ArtifactResult[]>([]);
  const [searchMeta, setSearchMeta] = useState<{ mode: string; fallback: boolean; total: number } | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    setIsSearching(true);
    setSearchMeta(null);

    try {
      if (searchMode === 'code') {
        const response = await apiClient.post<SearchResponse>('/debug/retrieval', {
          query: query.trim(),
          topK,
          searchMode: codeSearchMode,
        });
        let filtered = response.results;
        if (languageFilter) {
          filtered = filtered.filter((r) => r.language?.toLowerCase() === languageFilter.toLowerCase());
        }
        setCodeResults(filtered);
        setArtifactResults([]);
        setSearchMeta({ mode: response.mode, fallback: response.fallbackUsed, total: response.resultsFound });
      } else {
        const params = new URLSearchParams({ q: query.trim(), topK: String(topK) });
        const response = await apiClient.get<ArtifactResult[]>(`/artifacts/search?${params}`);
        setArtifactResults(response);
        setCodeResults([]);
        setSearchMeta({ mode: 'artifact', fallback: false, total: response.length });
      }
    } catch (error) {
      console.error('Search failed:', error);
      toast.error(error instanceof Error ? error.message : 'Search failed');
    } finally {
      setIsSearching(false);
    }
  }, [query, searchMode, codeSearchMode, languageFilter, topK]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const clearFilters = () => {
    setLanguageFilter('');
    setCodeSearchMode('auto');
    setTopK(10);
  };

  const hasResults = codeResults.length > 0 || artifactResults.length > 0;
  const hasActiveFilters = languageFilter || codeSearchMode !== 'auto' || topK !== 10;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <Eyebrow prefix>Hybrid Search</Eyebrow>
        <h1 className="text-2xl font-normal tracking-tight">
          [beacon] scans the repo.{' '}
          <span className="text-muted-foreground">BM25 + semantic, in one query.</span>
        </h1>
        <p className="font-mono text-xs text-muted-foreground">
          Ask in natural language or exact keywords. The beacon retrieves both.
        </p>
      </div>

      {/* Search Bar */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={searchMode === 'code' ? 'Search code: e.g., "auth guard usage", "database connection pool"' : 'Search artifacts: e.g., "OpenAPI schema", "Terraform modules"'}
              className="pl-10"
            />
          </div>
          <Button onClick={handleSearch} disabled={!query.trim() || isSearching}>
            {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
          <Button
            variant={showFilters ? 'secondary' : 'outline'}
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter className="h-4 w-4" />
            Filters
            {hasActiveFilters && (
              <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 text-[10px] justify-center">
                !
              </Badge>
            )}
          </Button>
        </div>

        {/* Search Mode Tabs */}
        <div className="flex gap-2">
          <Button
            variant={searchMode === 'code' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setSearchMode('code')}
          >
            <Code className="h-3.5 w-3.5" />
            Code Search
          </Button>
          <Button
            variant={searchMode === 'artifacts' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setSearchMode('artifacts')}
          >
            <FileText className="h-3.5 w-3.5" />
            Artifact Search
          </Button>
        </div>

        {/* Filters Panel */}
        {showFilters && (
          <div className="rounded-lg border border-border bg-card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Search Filters</h3>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-3 w-3" />
                  Clear filters
                </Button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {searchMode === 'code' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Search Mode</label>
                    <select
                      value={codeSearchMode}
                      onChange={(e) => setCodeSearchMode(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    >
                      {SEARCH_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {mode.charAt(0).toUpperCase() + mode.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Language</label>
                    <select
                      value={languageFilter}
                      onChange={(e) => setLanguageFilter(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    >
                      <option value="">All languages</option>
                      {LANGUAGES.map((lang) => (
                        <option key={lang} value={lang}>
                          {lang}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Results (top K)</label>
                <select
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  {[5, 10, 20, 50].map((k) => (
                    <option key={k} value={k}>
                      {k} results
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Search Metadata */}
      {searchMeta && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            Found <strong className="text-foreground">{searchMeta.total}</strong> results
          </span>
          <Badge variant="outline" className="text-[11px]">
            {searchMeta.mode}
          </Badge>
          {searchMeta.fallback && (
            <Badge variant="secondary" className="text-[11px]">
              fallback used
            </Badge>
          )}
        </div>
      )}

      {/* Code Results */}
      {codeResults.length > 0 && (
        <div className="border border-border bg-card divide-y divide-border">
          {codeResults.map((result, idx) => {
            const lineRange = result.lineStart != null
              ? `:${result.lineStart}${result.lineEnd != null && result.lineEnd !== result.lineStart ? `–${result.lineEnd}` : ''}`
              : '';
            const similarityPct = result.similarity != null ? Math.round(result.similarity * 100) : null;
            return (
              <div key={idx} className="p-4 hover:bg-foreground/[0.03] transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 font-mono text-sm">
                      <span className="select-none text-muted-foreground shrink-0" aria-hidden>[beacon]</span>
                      <Code className="h-3.5 w-3.5 text-muted-foreground shrink-0 translate-y-[2px]" aria-hidden />
                      <span className="text-foreground truncate" title={result.filePath}>
                        {result.filePath}
                        {lineRange && <span className="text-muted-foreground">{lineRange}</span>}
                      </span>
                    </div>
                    {(result.moduleName || result.language || result.framework) && (
                      <div className="mt-1.5 ml-[5.5rem] flex items-center gap-3 flex-wrap font-mono text-[11px] text-muted-foreground">
                        {result.moduleName && <span>{result.moduleName}</span>}
                        {result.language && <span>· {result.language}</span>}
                        {result.framework && <span>· {result.framework}</span>}
                      </div>
                    )}
                  </div>
                  {similarityPct !== null && (
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">match</div>
                      <div className="font-mono text-sm text-accent tabular-nums">{similarityPct}%</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Artifact Results */}
      {artifactResults.length > 0 && (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {artifactResults.map((artifact) => (
            <div key={artifact.id} className="p-4 hover:bg-accent/30 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="h-4 w-4 text-primary-500 shrink-0" />
                    <span className="text-sm font-medium">{artifact.name}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Badge variant="secondary" className="text-[11px]">
                      {artifact.type}
                    </Badge>
                  </div>
                  {artifact.content && (
                    <p className="text-xs text-muted-foreground mt-2 line-clamp-2 font-mono">
                      {artifact.content.slice(0, 200)}
                    </p>
                  )}
                </div>
                {artifact.similarity != null && (
                  <div className="text-right shrink-0">
                    <span className="text-xs text-muted-foreground">Relevance</span>
                    <div className="text-sm font-semibold text-foreground">
                      {Math.round(artifact.similarity * 100)}%
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isSearching && !hasResults && searchMeta && (
        <div className="py-10">
          <AgentStatusLine agent="beacon" level="pending">
            Scan complete. Zero hits. Try adjusting the query or widening the filters.
          </AgentStatusLine>
        </div>
      )}

      {/* Initial State */}
      {!isSearching && !hasResults && !searchMeta && (
        <div className="text-center py-16">
          <Search className="h-16 w-16 text-muted-foreground/20 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-1">Search your codebase</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Use semantic search to find code by meaning, BM25 for keyword matching, or hybrid for the best of both.
          </p>
          <div className="flex flex-wrap justify-center gap-2 mt-6">
            {['auth guard usage', 'database connection pool', 'error handling patterns', 'API endpoints'].map((example) => (
              <button
                key={example}
                onClick={() => setQuery(example)}
                className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
