/**
 * Phase 10 C1 — Public types for the content-addressed cache.
 *
 * These types are consumed by C2 (incremental ingestion) and C3
 * (watch daemon). Keep the surface small — `ArtifactKind` is the
 * closed set, anything else belongs in a different module.
 */

export type ArtifactKind = 'ast' | 'embeddings' | 'symbols' | 'graph_delta';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'ast',
  'embeddings',
  'symbols',
  'graph_delta',
] as const;

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}
