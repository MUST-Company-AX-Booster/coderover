import { useEffect, useState, useCallback } from 'react';
import { Network, Activity, RefreshCw, Layers, AlertTriangle, ArrowRight, Search, MessageSquare, Terminal } from 'lucide-react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import { getDependencies, getCycles, getHotspots, getImpact, GraphDataResponse, GraphCycle, GraphHotspot } from '../lib/api/graph';
import { Eyebrow } from '@/components/brand';
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Node,
  Edge,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import {
  GraphConfidenceLegend,
  dashArrayFor,
  opacityFor,
  normalizeEdgeTag,
} from '../components/GraphConfidenceLegend';

interface Repository {
  id: string;
  fullName: string;
  label: string;
}

interface RepoResponse {
  id: string;
  fullName: string;
  label?: string;
  [key: string]: unknown;
}

interface McpExecuteResponse {
  toolName: string;
  args: Record<string, unknown>;
  result: {
    query: string;
    generatedCypher: string;
    results: Record<string, unknown>[];
    error?: string;
  };
}

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'TB') => {
  const isHorizontal = direction === 'LR';
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 150, height: 50 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: isHorizontal ? Position.Left : Position.Top,
      sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
      position: {
        x: nodeWithPosition.x - 75,
        y: nodeWithPosition.y - 25,
      },
    };
  });

  return { nodes: newNodes, edges };
};

export default function GraphPage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'dependencies' | 'hotspots' | 'cycles' | 'impact' | 'query'>('dependencies');
  const [isLoading, setIsLoading] = useState(false);

  // Data states
  const [graphData, setGraphData] = useState<GraphDataResponse | null>(null);
  const [cycles, setCycles] = useState<GraphCycle[]>([]);
  const [hotspots, setHotspots] = useState<GraphHotspot[]>([]);
  
  // Impact state
  const [impactTarget, setImpactTarget] = useState('');
  const [impactResult, setImpactResult] = useState<string[] | null>(null);
  const [isImpactLoading, setIsImpactLoading] = useState(false);

  // AI Query state
  const [queryInput, setQueryInput] = useState('');
  const [queryResult, setQueryResult] = useState<{ query: string; generatedCypher: string; results: Record<string, unknown>[]; error?: string } | null>(null);
  const [isQueryLoading, setIsQueryLoading] = useState(false);

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const loadRepositories = useCallback(async () => {
    try {
      const data = await apiClient.get<RepoResponse[]>('/repos');
      const normalized = data.map(r => ({
        id: r.id,
        fullName: r.fullName,
        label: r.label || r.fullName,
      }));
      setRepositories(normalized);
      setSelectedRepoId(prev => {
        if (normalized.length > 0 && !prev) {
          return normalized[0].id;
        }
        return prev;
      });
    } catch (error) {
      console.error('Failed to load repositories:', error);
      toast.error('Failed to load repositories');
    }
  }, []);

  useEffect(() => {
    loadRepositories();
  }, [loadRepositories]);

  const loadGraphData = useCallback(async () => {
    if (!selectedRepoId) return;
    try {
      setIsLoading(true);
      const data = await getDependencies(selectedRepoId);
      setGraphData(data);
      
      const cyc = await getCycles(selectedRepoId);
      setCycles(cyc.cycles);
      
      const hot = await getHotspots(selectedRepoId);
      setHotspots(hot.hotspots);

      // Build flow graph
      const initialNodes: Node[] = Object.values(data.nodes).map((n) => ({
        id: n.filePath,
        position: { x: 0, y: 0 },
        data: { label: n.filePath.split('/').pop() || n.filePath },
        style: { border: '1px solid #777', padding: 10, borderRadius: 5, background: '#fff', color: '#333', fontSize: 12 },
      }));

      const initialEdges: Edge[] = data.edges.map((e, i) => {
        // Phase 10 B3: style by confidence (solid/dashed/dotted), opacity by
        // score. Gate on presence — legacy untagged edges are treated as
        // AMBIGUOUS so they remain visible but visibly low-confidence.
        const tag = normalizeEdgeTag(e.confidence);
        const score = typeof e.confidenceScore === 'number' ? e.confidenceScore : null;
        const strokeDasharray = dashArrayFor(tag);
        const opacity = opacityFor(tag, score);
        return {
          id: `e${i}-${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeDasharray, opacity },
          data: { confidence: tag, confidenceScore: score, relation: e.relation ?? null },
          ariaLabel: `edge ${e.source} \u2192 ${e.target}, confidence ${tag.toLowerCase()}`,
        };
      });

      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(initialNodes, initialEdges);
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);

    } catch (error) {
      console.error('Failed to load graph data:', error);
      toast.error('Failed to load graph data');
    } finally {
      setIsLoading(false);
    }
  }, [selectedRepoId, setNodes, setEdges]);

  useEffect(() => {
    if (selectedRepoId) {
      loadGraphData();
    } else {
      setGraphData(null);
      setCycles([]);
      setHotspots([]);
    }
  }, [selectedRepoId, loadGraphData]);

  const handleImpactSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepoId || !impactTarget) return;
    try {
      setIsImpactLoading(true);
      const res = await getImpact(selectedRepoId, impactTarget);
      setImpactResult(res.impactList);
    } catch (error) {
      console.error('Impact analysis failed', error);
      toast.error('Impact analysis failed');
    } finally {
      setIsImpactLoading(false);
    }
  };

  const handleAiQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepoId || !queryInput) return;
    try {
      setIsQueryLoading(true);
      const res = await apiClient.post<McpExecuteResponse>('/mcp/execute', {
        tool: 'query_code_graph',
        args: {
          repoId: selectedRepoId,
          query: queryInput,
        },
      });
      // The result is wrapped in { toolName, args, result: {...} }
      setQueryResult(res.result);
    } catch (error) {
      console.error('AI query failed', error);
      toast.error('AI query failed');
      setQueryResult({ query: queryInput, generatedCypher: '', results: [], error: String(error) });
    } finally {
      setIsQueryLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow prefix>Orbital Map</Eyebrow>
          <h1 className="text-2xl font-normal tracking-tight">
            The dependency graph.{' '}
            <span className="text-muted-foreground">Touch one module, see every module it pulls.</span>
          </h1>
          <p className="font-mono text-xs text-muted-foreground">
            [archive] indexes modules, functions, imports, and cycles.
          </p>
        </div>
        
        <div className="flex items-center space-x-3">
          <select
            className="input w-64"
            value={selectedRepoId}
            onChange={(e) => setSelectedRepoId(e.target.value)}
          >
            <option value="" disabled>Select a repository...</option>
            {repositories.map(repo => (
              <option key={repo.id} value={repo.id}>{repo.label}</option>
            ))}
          </select>
          <button onClick={loadGraphData} className="btn btn-outline p-2" disabled={isLoading || !selectedRepoId}>
            <RefreshCw className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {!selectedRepoId ? (
        <div className="card p-12 text-center">
          <Network className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-2">No repository selected</h3>
          <p className="text-muted-foreground">Please select or add a repository to view graph intelligence.</p>
        </div>
      ) : isLoading && !graphData ? (
        <div className="card p-12 flex justify-center">
          <RefreshCw className="h-8 w-8 text-primary-500 animate-spin" />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="border-b border-border">
            <nav className="flex space-x-8 px-6 overflow-x-auto" aria-label="Tabs">
              <button
                onClick={() => setActiveTab('dependencies')}
                className={`py-4 px-1 inline-flex items-center border-b-2 font-medium text-sm whitespace-nowrap ${
                  activeTab === 'dependencies'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <Network className="h-4 w-4 mr-2" />
                Dependency Graph
              </button>
              <button
                onClick={() => setActiveTab('hotspots')}
                className={`py-4 px-1 inline-flex items-center border-b-2 font-medium text-sm whitespace-nowrap ${
                  activeTab === 'hotspots'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <Activity className="h-4 w-4 mr-2" />
                Hotspots
              </button>
              <button
                onClick={() => setActiveTab('cycles')}
                className={`py-4 px-1 inline-flex items-center border-b-2 font-medium text-sm whitespace-nowrap ${
                  activeTab === 'cycles'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Cycles
              </button>
              <button
                onClick={() => setActiveTab('impact')}
                className={`py-4 px-1 inline-flex items-center border-b-2 font-medium text-sm whitespace-nowrap ${
                  activeTab === 'impact'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <Layers className="h-4 w-4 mr-2" />
                Impact Analysis
              </button>
              <button
                onClick={() => setActiveTab('query')}
                className={`py-4 px-1 inline-flex items-center border-b-2 font-medium text-sm whitespace-nowrap ${
                  activeTab === 'query'
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                AI Query
              </button>
            </nav>
          </div>

          <div className="p-6">
            {activeTab === 'dependencies' && (
              <div className="h-[600px] border border-border rounded-lg bg-foreground/5 relative">
                {nodes.length > 0 ? (
                  <>
                    <ReactFlow
                      nodes={nodes}
                      edges={edges}
                      onNodesChange={onNodesChange}
                      onEdgesChange={onEdgesChange}
                      fitView
                      attributionPosition="bottom-right"
                    >
                      <Background color="#ccc" gap={16} />
                      <Controls />
                    </ReactFlow>
                    <GraphConfidenceLegend />
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    No dependencies found in this repository.
                  </div>
                )}
              </div>
            )}

            {activeTab === 'hotspots' && (
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-foreground mb-4">Architectural Hotspots</h3>
                <p className="text-sm text-muted-foreground mb-4">Modules ranked by in-degree (how frequently they are imported). High in-degree modules are critical bottlenecks.</p>
                {hotspots.length === 0 ? (
                  <p className="text-muted-foreground">No hotspots detected.</p>
                ) : (
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <table className="min-w-full divide-y divide-border">
                      <thead className="bg-foreground/5">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">File Path</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">In-Degree</th>
                        </tr>
                      </thead>
                      <tbody className="bg-card divide-y divide-border">
                        {hotspots.map((hotspot, idx) => (
                          <tr key={idx}>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-foreground font-medium">{hotspot.filePath}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-error-100 text-error-800">
                                {hotspot.inDegree} imports
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'cycles' && (
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-foreground mb-4">Circular Dependencies</h3>
                <p className="text-sm text-muted-foreground mb-4">Detected dependency cycles. These can cause initialization issues and tight coupling.</p>
                {cycles.length === 0 ? (
                  <div className="p-6 bg-success-50 text-success-700 rounded-lg flex items-center">
                    <Activity className="h-5 w-5 mr-2" />
                    No circular dependencies detected! Excellent architecture.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {cycles.map((cycle, idx) => (
                      <div key={idx} className="p-4 bg-error-50 border border-error-200 rounded-lg">
                        <div className="flex items-center space-x-2 text-error-700 font-medium mb-2">
                          <AlertTriangle className="h-4 w-4" />
                          <span>Cycle #{idx + 1}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm text-error-600">
                          {cycle.chain.map((node, nIdx) => (
                            <div key={nIdx} className="flex items-center">
                              <span className="bg-card border border-error-200 px-2 py-1 rounded shadow-sm">{node}</span>
                              {nIdx < cycle.chain.length - 1 && <ArrowRight className="h-4 w-4 mx-1" />}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'impact' && (
              <div className="space-y-6">
                <div className="max-w-2xl">
                  <h3 className="text-lg font-medium text-foreground mb-2">Impact Analysis</h3>
                  <p className="text-sm text-muted-foreground mb-4">Select a file to see all downstream dependencies that would be affected by a change.</p>
                  
                  <form onSubmit={handleImpactSearch} className="flex gap-3">
                    <div className="flex-1 relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <input
                        type="text"
                        className="input pl-10 w-full"
                        placeholder="e.g. src/auth/auth.service.ts"
                        value={impactTarget}
                        onChange={(e) => setImpactTarget(e.target.value)}
                        required
                      />
                    </div>
                    <button type="submit" className="btn btn-primary" disabled={isImpactLoading}>
                      {isImpactLoading ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : 'Analyze'}
                    </button>
                  </form>
                </div>

                {impactResult && (
                  <div className="mt-6">
                    <h4 className="text-md font-medium text-foreground mb-3">
                      Impacted Files ({impactResult.length})
                    </h4>
                    {impactResult.length === 0 ? (
                      <p className="text-sm text-muted-foreground">This file has no downstream dependencies.</p>
                    ) : (
                      <div className="bg-card border border-border rounded-lg overflow-hidden">
                        <ul className="divide-y divide-border">
                          {impactResult.map((path, idx) => (
                            <li key={idx} className="px-4 py-3 text-sm text-foreground hover:bg-foreground/5">
                              {path}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'query' && (
              <div className="space-y-6">
                <div className="max-w-3xl">
                  <h3 className="text-lg font-medium text-foreground mb-2">AI Graph Query</h3>
                  <p className="text-sm text-muted-foreground mb-4">Ask complex questions about your codebase structure using natural language.</p>
                  
                  <form onSubmit={handleAiQuery} className="space-y-4">
                    <div>
                      <textarea
                        className="input w-full h-24 pt-2"
                        placeholder="e.g. What services depend on AuthService? Or: Show me all classes that inherit from BaseEntity."
                        value={queryInput}
                        onChange={(e) => setQueryInput(e.target.value)}
                        required
                      />
                    </div>
                    <div className="flex justify-end">
                      <button type="submit" className="btn btn-primary" disabled={isQueryLoading}>
                        {isQueryLoading ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Terminal className="h-4 w-4 mr-2" />}
                        Run Query
                      </button>
                    </div>
                  </form>
                </div>

                {queryResult && (
                  <div className="space-y-6 animate-in fade-in duration-300">
                    {queryResult.error ? (
                      <div className="p-4 bg-error-50 border border-error-200 rounded-lg text-error-700">
                        <p className="font-medium">Query Failed</p>
                        <p className="text-sm">{queryResult.error}</p>
                      </div>
                    ) : (
                      <>
                        <div className="bg-foreground/5 text-foreground p-4 rounded-lg font-mono text-sm overflow-x-auto">
                          <div className="text-muted-foreground text-xs mb-1 uppercase tracking-wider">Generated Cypher</div>
                          {queryResult.generatedCypher}
                        </div>

                        <div>
                          <h4 className="text-md font-medium text-foreground mb-3">
                            Results ({queryResult.results.length})
                          </h4>
                          {queryResult.results.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No results found.</p>
                          ) : (
                            <div className="bg-card border border-border rounded-lg overflow-hidden overflow-x-auto">
                              <table className="min-w-full divide-y divide-border">
                                <thead className="bg-foreground/5">
                                  <tr>
                                    {Object.keys(queryResult.results[0]).map((key) => (
                                      <th key={key} className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                        {key}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody className="bg-card divide-y divide-border">
                                  {queryResult.results.map((row, idx) => (
                                    <tr key={idx}>
                                      {Object.values(row).map((val, vIdx) => (
                                        <td key={vIdx} className="px-6 py-4 whitespace-nowrap text-sm text-foreground">
                                          {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
