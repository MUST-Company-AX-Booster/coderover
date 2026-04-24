/**
 * CONTRACT: byte-identical to coderover-api/src/graph/deterministic-ids.ts.
 *
 * If you change this file, you MUST change the backend file too and re-run
 * `packages/mcp/test/local/deterministic-ids.contract.spec.ts` to confirm.
 * A mismatch silently breaks cross-referencing between local and remote mode.
 */

import * as crypto from 'crypto';

/**
 * Phase 10 C2 / C2-bis — Deterministic graph identity.
 *
 * Every graph node and edge is keyed by a stable, content-derived ID so
 * re-ingesting an unchanged repo is a no-op and renames preserve edges.
 *
 * Choice: SHA256 truncated to 16 hex chars (8 bytes, 64 bits). At 100k
 * symbols per repo the birthday-bound collision probability is ~2.7e-10,
 * i.e. negligible. The short form keeps Cypher parameter payloads small
 * and Memgraph property storage compact without meaningfully increasing
 * collision risk.
 *
 * Coordination contract: B2 (producers workstream) independently computes
 * these IDs from the same formulas. The SEPARATOR and the field ordering
 * below are the cross-workstream contract. Do NOT change either without
 * cross-workstream coordination — it will desync the graph.
 *
 * Pure functions, no DI: callable from services, tests, and migrations.
 */

// Separator chosen as a non-printable ASCII control so no legal filePath,
// symbolKind, or qualifiedName character can collide with it. `\x1f` is the
// ASCII "unit separator", designed for this exact purpose.
const SEPARATOR = '\x1f';

const ID_LENGTH_HEX = 16; // 8 bytes — see header comment for collision math.

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, ID_LENGTH_HEX);
}

/**
 * Deterministic identity for a graph node.
 *
 * The tuple `(filePath, symbolKind, qualifiedName)` is the identity
 * contract:
 *   - Two different runs with the same file contents produce the same ID.
 *   - Rename that preserves `qualifiedName` keeps the ID stable
 *     IF the caller supplies the qualifiedName as the identity anchor.
 *     (C2's delta-apply relies on this for rename-preserves-edges.)
 *   - A file-scope prefix check (`nodeId` startsWith shortHash(filePath))
 *     is NOT reliable because SHA256 shuffles the output; for "find nodes
 *     in this file" use the `filePath` property on the node, not the ID.
 */
export function computeNodeId(
  filePath: string,
  symbolKind: string,
  qualifiedName: string,
): string {
  if (filePath == null || symbolKind == null || qualifiedName == null) {
    throw new Error(
      `computeNodeId: all three fields are required (filePath=${filePath!}, symbolKind=${symbolKind!}, qualifiedName=${qualifiedName!})`,
    );
  }
  return shortHash(`${filePath}${SEPARATOR}${symbolKind}${SEPARATOR}${qualifiedName}`);
}

/**
 * Deterministic identity for a graph edge.
 *
 * An edge's identity is its endpoints + the relation kind. Parallel
 * edges of a different kind between the same pair therefore get
 * different IDs, which is correct (CALLS and IMPORTS between the same
 * nodes are distinct facts).
 */
export function computeEdgeId(
  srcId: string,
  dstId: string,
  relationKind: string,
): string {
  if (!srcId || !dstId || !relationKind) {
    throw new Error(
      `computeEdgeId: all three fields are required (srcId=${srcId}, dstId=${dstId}, relationKind=${relationKind})`,
    );
  }
  return shortHash(`${srcId}${SEPARATOR}${dstId}${SEPARATOR}${relationKind}`);
}

/** Length of the returned ID in hex characters. Exposed for tests / docs. */
export const DETERMINISTIC_ID_HEX_LENGTH = ID_LENGTH_HEX;
