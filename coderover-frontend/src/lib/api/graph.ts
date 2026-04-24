import { apiClient } from './client';

export interface GraphNode {
  filePath: string;
  moduleName: string | null;
  nestRole: string | null;
  dependenciesCount?: number;
}

/** Phase 10 B1 tag — gated by presence, legacy untagged edges treat as AMBIGUOUS. */
export type EdgeConfidenceTag = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export interface GraphEdge {
  source: string;
  target: string;
  /** Relation kind (e.g. "imports", "extends"). Drives edge color. */
  relation?: string | null;
  /** Phase 10 B1: confidence tag on the edge. Drives line style. */
  confidence?: EdgeConfidenceTag;
  /** Phase 10 B1: confidence score [0-1], nullable. Drives opacity. */
  confidenceScore?: number | null;
}

export interface GraphDataResponse {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  cycles: GraphCycle[];
  hotspots: GraphHotspot[];
}

export interface GraphCycle {
  chain: string[];
}

export interface GraphCyclesResponse {
  cyclesCount: number;
  cycles: GraphCycle[];
}

export interface GraphHotspot {
  filePath: string;
  moduleName: string | null;
  inDegree: number;
}

export interface GraphHotspotsResponse {
  hotspots: GraphHotspot[];
}

export interface GraphImpactResponse {
  target: string;
  impactCount: number;
  impactList: string[];
}

export const getDependencies = async (repoId: string): Promise<GraphDataResponse> => {
  return apiClient.get<GraphDataResponse>(`/graph/dependencies?repoId=${repoId}`);
};

export const getCycles = async (repoId: string): Promise<GraphCyclesResponse> => {
  return apiClient.get<GraphCyclesResponse>(`/graph/cycles?repoId=${repoId}`);
};

export const getHotspots = async (repoId: string): Promise<GraphHotspotsResponse> => {
  return apiClient.get<GraphHotspotsResponse>(`/graph/hotspots?repoId=${repoId}`);
};

export const getImpact = async (repoId: string, filePath: string): Promise<GraphImpactResponse> => {
  return apiClient.get<GraphImpactResponse>(`/graph/impact?repoId=${repoId}&filePath=${encodeURIComponent(filePath)}`);
};
