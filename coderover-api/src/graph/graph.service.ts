import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ImportInfo } from '../ingest/ast.service';
import * as path from 'path';
import { MemgraphService } from './memgraph.service';
import { ConfidenceTaggerService } from './confidence-tagger.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { computeEdgeId, computeNodeId } from './deterministic-ids';

export interface GraphNode {
  filePath: string;
  moduleName: string | null;
  nestRole: string | null;
  imports: ImportInfo[];
  dependencies: string[]; // List of resolved filePaths
  inDegree: number;
}

export interface GraphCycle {
  chain: string[];
}

export interface GraphHotspot {
  filePath: string;
  moduleName: string | null;
  inDegree: number;
}

export interface GraphData {
  nodes: Record<string, GraphNode>;
  edges: { source: string; target: string }[];
  cycles: GraphCycle[];
  hotspots: GraphHotspot[];
}

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  /** Label written into `edge_producer_audit.producer` for graph-sync edges. */
  static readonly GRAPH_SYNC_PRODUCER = 'ast:graph-sync';

  constructor(
    private readonly dataSource: DataSource,
    private readonly memgraphService: MemgraphService,
    @InjectRepository(EdgeProducerAudit)
    private readonly edgeAuditRepo: Repository<EdgeProducerAudit>,
    private readonly confidenceTagger: ConfidenceTaggerService,
  ) {}

  /**
   * Syncs the entire repository graph from Postgres to Memgraph.
   */
  async syncRepoToMemgraph(repoId: string): Promise<void> {
    this.logger.log(`Syncing repo ${repoId} to Memgraph...`);
    const graph = await this.buildGraph(repoId);
    
    // Fetch all symbols from code_chunks to add fine-grained nodes
    const chunkRows = await this.dataSource.query(
      `SELECT file_path, symbols FROM code_chunks WHERE repo_id = $1`,
      [repoId]
    );

    const session = this.memgraphService.getSession();
    try {
      // 1. Clear existing nodes for this repo
      await session.executeWrite(tx => 
        tx.run('MATCH (n {repoId: $repoId}) DETACH DELETE n', { repoId })
      );

      // 2. Insert File Nodes
      // Phase 10 C2: attach deterministic `node_id` so incremental
      // ingest (and future graph consumers) can address this entity
      // by a stable hash rather than a label+prop tuple.
      for (const node of Object.values(graph.nodes)) {
        const fileNodeId = computeNodeId(node.filePath, 'file', node.filePath);
        await session.executeWrite(tx =>
          tx.run(`
            CREATE (f:File {
              repoId: $repoId,
              filePath: $filePath,
              moduleName: $moduleName,
              nestRole: $nestRole,
              node_id: $nodeId
            })
          `, {
            repoId,
            filePath: node.filePath,
            moduleName: node.moduleName || '',
            nestRole: node.nestRole || '',
            nodeId: fileNodeId,
          })
        );
      }

      // 3. Insert Symbol Nodes and DEFINES edges (Legacy/Simple symbols)
      // We keep this for backward compatibility or simple views, but we will also add granular nodes below.
      for (const row of chunkRows) {
        if (!row.symbols) continue;
        const symbols = row.symbols as any[]; // SymbolInfo[]

        for (const sym of symbols) {
          const fileNodeId = computeNodeId(row.file_path, 'file', row.file_path);
          const symbolNodeId = computeNodeId(row.file_path, sym.kind, sym.name);
          const definesEdgeId = computeEdgeId(fileNodeId, symbolNodeId, 'DEFINES');
          await session.executeWrite(tx =>
            tx.run(`
              MATCH (f:File {repoId: $repoId, filePath: $filePath})
              MERGE (s:Symbol {
                repoId: $repoId,
                name: $name,
                kind: $kind,
                filePath: $filePath
              })
              ON CREATE SET s.node_id = $symbolNodeId
              SET s.node_id = coalesce(s.node_id, $symbolNodeId)
              MERGE (f)-[e:DEFINES]->(s)
              ON CREATE SET e.edge_id = $definesEdgeId
              SET e.edge_id = coalesce(e.edge_id, $definesEdgeId)
            `, {
              repoId,
              filePath: row.file_path,
              name: sym.name,
              kind: sym.kind,
              symbolNodeId,
              definesEdgeId,
            })
          );
          await this.recordEdgeAudit({
            srcFilePath: row.file_path,
            srcSymbolKind: 'file',
            srcQualifiedName: row.file_path,
            dstFilePath: row.file_path,
            dstSymbolKind: sym.kind,
            dstQualifiedName: sym.name,
            relationKind: 'DEFINES',
            refs: { repoId, filePath: row.file_path, symbol: sym.name, kind: sym.kind },
          });
        }
      }

      // --- PHASE 7 ENHANCEMENTS ---

      // 3b. Insert Class and Method Nodes (from code_methods)
      const methods = await this.dataSource.query(
        `SELECT * FROM code_methods WHERE repo_id = $1`,
        [repoId]
      );

      for (const m of methods) {
        // Create Class node if it exists (implied by method having class_name)
        // Note: Independent classes should be in 'symbols' above, but we ensure they exist here for linking.
        if (m.class_name) {
            const fileNodeId = computeNodeId(m.file_path, 'file', m.file_path);
            const classNodeId = computeNodeId(m.file_path, 'class', m.class_name);
            // Qualified name for a method is `Class.method` — this is what
            // downstream C2 rename-preservation depends on: if the
            // enclosing class keeps its name, the method's node_id is stable
            // even when the file moves.
            const methodQualifiedName = `${m.class_name}.${m.method_name}`;
            const methodNodeId = computeNodeId(m.file_path, 'method', methodQualifiedName);
            const fileDefinesClassEdgeId = computeEdgeId(fileNodeId, classNodeId, 'DEFINES');
            const classDefinesMethodEdgeId = computeEdgeId(classNodeId, methodNodeId, 'DEFINES');
            await session.executeWrite(tx =>
                tx.run(`
                  MATCH (f:File {repoId: $repoId, filePath: $filePath})
                  MERGE (c:Class {
                    repoId: $repoId,
                    name: $className,
                    filePath: $filePath
                  })
                  ON CREATE SET c.node_id = $classNodeId
                  SET c.node_id = coalesce(c.node_id, $classNodeId)
                  MERGE (f)-[fdc:DEFINES]->(c)
                  ON CREATE SET fdc.edge_id = $fileDefinesClassEdgeId
                  SET fdc.edge_id = coalesce(fdc.edge_id, $fileDefinesClassEdgeId)
                  MERGE (m:Method {
                    repoId: $repoId,
                    name: $methodName,
                    className: $className,
                    filePath: $filePath,
                    args: $args
                  })
                  ON CREATE SET m.node_id = $methodNodeId
                  SET m.node_id = coalesce(m.node_id, $methodNodeId)
                  MERGE (c)-[cdm:DEFINES]->(m)
                  ON CREATE SET cdm.edge_id = $classDefinesMethodEdgeId
                  SET cdm.edge_id = coalesce(cdm.edge_id, $classDefinesMethodEdgeId)
                `, {
                  repoId,
                  filePath: m.file_path,
                  className: m.class_name,
                  methodName: m.method_name,
                  args: JSON.stringify(m.parameters),
                  classNodeId,
                  methodNodeId,
                  fileDefinesClassEdgeId,
                  classDefinesMethodEdgeId,
                })
            );
            // Phase 10 B2: one audit row per MERGE'd edge (two per loop iter).
            await this.recordEdgeAudit({
              srcFilePath: m.file_path,
              srcSymbolKind: 'file',
              srcQualifiedName: m.file_path,
              dstFilePath: m.file_path,
              dstSymbolKind: 'class',
              dstQualifiedName: m.class_name,
              relationKind: 'DEFINES',
              refs: { repoId, filePath: m.file_path, className: m.class_name },
            });
            await this.recordEdgeAudit({
              srcFilePath: m.file_path,
              srcSymbolKind: 'class',
              srcQualifiedName: m.class_name,
              dstFilePath: m.file_path,
              dstSymbolKind: 'method',
              dstQualifiedName: `${m.class_name}.${m.method_name}`,
              relationKind: 'DEFINES',
              refs: {
                repoId,
                filePath: m.file_path,
                className: m.class_name,
                methodName: m.method_name,
              },
            });
        } else {
            // It's a top-level function (if we stored them in code_methods with empty class_name?)
            // Our schema has class_name NOT NULL? Let's check. 
            // In migration: class_name TEXT NOT NULL. 
            // So code_methods ONLY stores methods inside classes.
            // Top-level functions are in 'symbols' (kind='function').
            // We might want to upgrade 'symbols' to 'Function' nodes for top-level functions to attach CALLS.
        }
      }

      // 3c. Upgrade top-level Function symbols to Function nodes to support CALLS
      await session.executeWrite(tx => 
        tx.run(`
          MATCH (s:Symbol {repoId: $repoId, kind: 'function'})
          SET s:Function
        `, { repoId })
      );

      // 3d. Insert Inheritance (from code_inheritance)
      const inheritance = await this.dataSource.query(
        `SELECT * FROM code_inheritance WHERE repo_id = $1`,
        [repoId]
      );
      
      for (const inh of inheritance) {
          if (inh.extends_class) {
              // INHERITS endpoints: sub's node_id is deterministic; sup's
              // node_id is only knowable once MATCH resolves — the super
              // class may live in a different file. Read back both ends
              // after MERGE, then compute edge_id and SET it.
              const result = await session.executeWrite(tx =>
                tx.run(`
                  MATCH (sub:Class {repoId: $repoId, filePath: $filePath, name: $className})
                  MATCH (sup:Class {repoId: $repoId, name: $extendsClass})
                  MERGE (sub)-[e:INHERITS]->(sup)
                  RETURN sub.node_id AS subId, sup.node_id AS supId, e.edge_id AS existingEdgeId
                `, {
                  repoId,
                  filePath: inh.file_path,
                  className: inh.class_name,
                  extendsClass: inh.extends_class
                })
              );
              // Phase 10 B2: superclass file path is unknown at MERGE time
              // (Cypher resolves it cross-file). Use empty string as a
              // deterministic placeholder — C2 computes the same.
              await this.recordEdgeAudit({
                srcFilePath: inh.file_path,
                srcSymbolKind: 'class',
                srcQualifiedName: inh.class_name,
                dstFilePath: '',
                dstSymbolKind: 'class',
                dstQualifiedName: inh.extends_class,
                relationKind: 'INHERITS',
                refs: {
                  repoId,
                  filePath: inh.file_path,
                  className: inh.class_name,
                  extendsClass: inh.extends_class,
                },
              });
              for (const rec of result.records) {
                  const subId = rec.get('subId');
                  const supId = rec.get('supId');
                  const existing = rec.get('existingEdgeId');
                  if (!subId || !supId || existing) continue;
                  const inheritsEdgeId = computeEdgeId(subId, supId, 'INHERITS');
                  await session.executeWrite(tx =>
                    tx.run(`
                      MATCH (sub:Class {repoId: $repoId, filePath: $filePath, name: $className})
                      MATCH (sup:Class {repoId: $repoId, name: $extendsClass})
                      MATCH (sub)-[e:INHERITS]->(sup)
                      SET e.edge_id = coalesce(e.edge_id, $inheritsEdgeId)
                    `, {
                      repoId,
                      filePath: inh.file_path,
                      className: inh.class_name,
                      extendsClass: inh.extends_class,
                      inheritsEdgeId,
                    })
                  );
              }
          }
      }

      // 4. Insert IMPORTS Edges (moved before CALLS so we can use them for resolution)
      for (const edge of graph.edges) {
        const sourceNodeId = computeNodeId(edge.source, 'file', edge.source);
        const targetNodeId = computeNodeId(edge.target, 'file', edge.target);
        const importsEdgeId = computeEdgeId(sourceNodeId, targetNodeId, 'IMPORTS');
        await session.executeWrite(tx =>
          tx.run(`
            MATCH (source:File {repoId: $repoId, filePath: $sourcePath})
            MATCH (target:File {repoId: $repoId, filePath: $targetPath})
            MERGE (source)-[e:IMPORTS]->(target)
            ON CREATE SET e.edge_id = $importsEdgeId
            SET e.edge_id = coalesce(e.edge_id, $importsEdgeId)
          `, {
            repoId,
            sourcePath: edge.source,
            targetPath: edge.target,
            importsEdgeId,
          })
        );
        await this.recordEdgeAudit({
          srcFilePath: edge.source,
          srcSymbolKind: 'file',
          srcQualifiedName: edge.source,
          dstFilePath: edge.target,
          dstSymbolKind: 'file',
          dstQualifiedName: edge.target,
          relationKind: 'IMPORTS',
          refs: { repoId, source: edge.source, target: edge.target },
        });
      }

      // 3e. Insert Calls (from code_calls)
      const calls = await this.dataSource.query(
        `SELECT * FROM code_calls WHERE repo_id = $1`,
        [repoId]
      );

      for (const call of calls) {
        // Step 1: MERGE the CALLS edge(s) and return endpoint node_ids.
        // Step 2: for each returned endpoint pair, compute edge_id in JS
        // and SET it in Memgraph — Cypher has no SHA256, so ID
        // computation has to round-trip through Node.
        const result = await session.executeWrite(tx =>
            tx.run(`
              // Find caller
              OPTIONAL MATCH (callerFunction:Function {repoId: $repoId, filePath: $callerFile, name: $callerName})
              OPTIONAL MATCH (callerMethod:Method {repoId: $repoId, filePath: $callerFile, name: $callerName})
              WITH coalesce(callerFunction, callerMethod) AS caller
              WHERE caller IS NOT NULL

              // Find the caller's file
              MATCH (callerFileNode:File {repoId: $repoId, filePath: $callerFile})

              // Find potential callees
              MATCH (callee)
              WHERE callee.repoId = $repoId AND (
                (callee:Function AND callee.name = $calleeName) OR
                (callee:Method AND callee.name = $calleeName) OR
                (callee:Class AND callee.name = $calleeName)
              )

              // Find the callee's file
              MATCH (calleeFileNode:File {repoId: $repoId, filePath: callee.filePath})

              // Resolution logic: prioritize same file or imported files.
              OPTIONAL MATCH (callerFileNode)-[imp:IMPORTS]->(calleeFileNode)
              WITH caller, callee,
                   CASE
                     WHEN callee.filePath = $callerFile THEN 2
                     WHEN imp IS NOT NULL THEN 1
                     ELSE 0
                   END AS score

              WITH caller, callee, score
              ORDER BY score DESC
              WITH caller, collect({callee: callee, score: score}) as candidates

              WITH caller, [c IN candidates WHERE c.score = candidates[0].score | c.callee] AS bestCallees

              UNWIND bestCallees AS bestCallee
              MERGE (caller)-[e:CALLS]->(bestCallee)
              RETURN caller.node_id AS callerId, bestCallee.node_id AS calleeId, e.edge_id AS existingEdgeId
            `, {
              repoId,
              callerFile: call.caller_file,
              callerName: call.caller_name,
              calleeName: call.callee_name
            })
        );
        // Phase 10 B2: callee file is resolved inside the Cypher; the audit
        // row uses the pre-resolution identifiers from `code_calls`. C2
        // computes the same pair so the edge_id matches.
        await this.recordEdgeAudit({
          srcFilePath: call.caller_file,
          srcSymbolKind: call.caller_kind ?? 'function',
          srcQualifiedName: call.caller_name,
          dstFilePath: '',
          dstSymbolKind: 'callee',
          dstQualifiedName: call.callee_qualified ?? call.callee_name,
          relationKind: 'CALLS',
          refs: {
            repoId,
            callerFile: call.caller_file,
            callerName: call.caller_name,
            calleeName: call.callee_name,
            calleeQualified: call.callee_qualified ?? null,
            line: call.call_line ?? null,
          },
        });

        // Phase 10 C2: stamp edge_id on the bound CALLS edge(s) so B1's
        // re-tag job can match audit rows to edges. Two-step pattern
        // because Cypher has no SHA256 — compute in JS after MERGE returns.
        for (const rec of result.records) {
          const callerId = rec.get('callerId');
          const calleeId = rec.get('calleeId');
          const existing = rec.get('existingEdgeId');
          if (!callerId || !calleeId || existing) continue;
          const callsEdgeId = computeEdgeId(callerId, calleeId, 'CALLS');
          await session.executeWrite(tx =>
            tx.run(`
              MATCH (caller {node_id: $callerId})
              MATCH (callee {node_id: $calleeId})
              MATCH (caller)-[e:CALLS]->(callee)
              SET e.edge_id = coalesce(e.edge_id, $callsEdgeId)
            `, { callerId, calleeId, callsEdgeId })
          );
        }
      }

      this.logger.log(`Successfully synced repo ${repoId} to Memgraph`);
    } catch (error) {
      this.logger.error(`Failed to sync repo ${repoId} to Memgraph`, error);
    } finally {
      await session.close();
    }
  }

  /**
   * Phase 10 B2 — record one `edge_producer_audit` row for a graph-sync
   * edge MERGE. Called from the Cypher loop sites after `executeWrite`
   * resolves. Never throws — audit failures must not block the primary
   * Memgraph sync. The background re-tag job (B1) later reads these rows
   * and matches them to edges by `edge_id` once C2 writes that property.
   *
   * All graph-sync edges are AST-derived → EXTRACTED / score 1.0 through
   * `ConfidenceTaggerService`.
   */
  private async recordEdgeAudit(params: {
    srcFilePath: string;
    srcSymbolKind: string;
    srcQualifiedName: string;
    dstFilePath: string;
    dstSymbolKind: string;
    dstQualifiedName: string;
    relationKind: string;
    refs?: unknown;
  }): Promise<void> {
    if (!this.edgeAuditRepo || !this.confidenceTagger) return;

    try {
      const srcId = computeNodeId(
        params.srcFilePath,
        params.srcSymbolKind,
        params.srcQualifiedName,
      );
      const dstId = computeNodeId(
        params.dstFilePath,
        params.dstSymbolKind,
        params.dstQualifiedName,
      );
      const edgeId = computeEdgeId(srcId, dstId, params.relationKind);

      const evidence = this.confidenceTagger.tag({
        producer: GraphService.GRAPH_SYNC_PRODUCER,
        producerKind: 'ast',
        refs: params.refs ?? null,
      });

      await this.edgeAuditRepo.insert({
        edgeId,
        relationKind: params.relationKind,
        producer: GraphService.GRAPH_SYNC_PRODUCER,
        producerKind: evidence.tag,
        producerConfidence: evidence.score,
        evidenceRef: evidence.evidence_ref as any,
      });
    } catch (err) {
      this.logger.debug(
        `edge_producer_audit insert failed (${params.relationKind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Retrieves all unique files and their imports for a given repository.
   */
  async buildGraph(repoId: string): Promise<GraphData> {
    const sql = `
      SELECT DISTINCT ON (file_path)
        file_path AS "filePath",
        module_name AS "moduleName",
        nest_role AS "nestRole",
        imports
      FROM code_chunks
      WHERE repo_id = $1 AND imports IS NOT NULL
    `;
    const rows = await this.dataSource.query(sql, [repoId]);

    const nodes: Record<string, GraphNode> = {};
    const edges: { source: string; target: string }[] = [];

    // Initialize nodes
    for (const row of rows) {
      nodes[row.filePath] = {
        filePath: row.filePath,
        moduleName: row.moduleName,
        nestRole: row.nestRole,
        imports: row.imports || [],
        dependencies: [],
        inDegree: 0,
      };
    }

    // Resolve dependencies (edges)
    for (const node of Object.values(nodes)) {
      for (const imp of node.imports) {
        const resolvedPath = this.resolveImportPath(node.filePath, imp.source, Object.keys(nodes));
        if (resolvedPath && nodes[resolvedPath]) {
          if (!node.dependencies.includes(resolvedPath)) {
            node.dependencies.push(resolvedPath);
            nodes[resolvedPath].inDegree++;
            edges.push({ source: node.filePath, target: resolvedPath });
          }
        }
      }
    }

    const cycles = this.detectCycles(nodes);
    const hotspots = this.calculateHotspots(nodes);

    return { nodes, edges, cycles, hotspots };
  }

  /**
   * Impact Analysis: Traverse reverse dependencies starting from a file.
   */
  async analyzeImpact(repoId: string, filePath: string): Promise<string[]> {
    const graph = await this.buildGraph(repoId);
    if (!graph.nodes[filePath]) return [];

    const reverseGraph: Record<string, string[]> = {};
    for (const edge of graph.edges) {
      if (!reverseGraph[edge.target]) reverseGraph[edge.target] = [];
      reverseGraph[edge.target].push(edge.source);
    }

    const impactSet = new Set<string>();
    const queue = [filePath];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = reverseGraph[current] || [];
      for (const dep of dependents) {
        if (!impactSet.has(dep)) {
          impactSet.add(dep);
          queue.push(dep);
        }
      }
    }

    return Array.from(impactSet);
  }

  resolveImportPath(currentPath: string, importSource: string, allFiles: string[]): string | null {
    // Strip extension from importSource if present
    const baseSource = importSource.replace(/\.(ts|tsx|js|jsx|py|go|java|kt|php|rs)$/, '');

    // 1. Relative imports (e.g. ./module, ../module)
    if (baseSource.startsWith('.')) {
      const dir = path.dirname(currentPath);
      // normalize path to remove ./ and ../
      const resolved = path.normalize(path.join(dir, baseSource));
      
      // Look for exact match or with extensions
      for (const ext of [
        '', '.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.vue',
        '.py', '/__init__.py', '.go', '.java', '.kt', '.php', '.rs'
      ]) {
        const target = resolved + ext;
        if (allFiles.includes(target)) return target;
      }
    } else {
      // 2. Absolute or aliased imports (e.g. src/..., @/..., or Python absolute imports like `app.models.user`)
      
      // Convert Python/Java dot-notation imports to path notation if they don't look like file paths
      let cleanSource = baseSource;
      if (!cleanSource.includes('/') && cleanSource.includes('.')) {
        cleanSource = cleanSource.replace(/\./g, '/');
      } else {
        cleanSource = cleanSource.replace(/^[@~]\//, '');
      }

      const suffixes = [
        `/${cleanSource}.ts`,
        `/${cleanSource}.tsx`,
        `/${cleanSource}/index.ts`,
        `/${cleanSource}.py`,
        `/${cleanSource}/__init__.py`,
        `/${cleanSource}.go`,
        `/${cleanSource}.java`,
        `/${cleanSource}.kt`,
        `/${cleanSource}.php`,
        `/${cleanSource}.rs`,
        `/${cleanSource}`
      ];
      
      const match = allFiles.find(f => suffixes.some(suffix => f.endsWith(suffix)));
      if (match) return match;
    }
    return null;
  }

  private detectCycles(nodes: Record<string, GraphNode>): GraphCycle[] {
    const cycles: GraphCycle[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const pathList: string[] = [];

    const dfs = (nodeId: string) => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      pathList.push(nodeId);

      const node = nodes[nodeId];
      for (const dep of node.dependencies) {
        if (!visited.has(dep)) {
          dfs(dep);
        } else if (recursionStack.has(dep)) {
          // Cycle detected
          const cycleStartIndex = pathList.indexOf(dep);
          const cycleChain = pathList.slice(cycleStartIndex);
          cycleChain.push(dep); // complete the loop
          
          // Avoid duplicate cycles by normalizing the chain representation
          cycles.push({ chain: cycleChain });
        }
      }

      recursionStack.delete(nodeId);
      pathList.pop();
    };

    for (const nodeId of Object.keys(nodes)) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }

    // Deduplicate cycles
    const uniqueCycles = new Map<string, GraphCycle>();
    for (const c of cycles) {
      const sortedChain = [...c.chain.slice(0, -1)].sort().join('->');
      if (!uniqueCycles.has(sortedChain)) {
        uniqueCycles.set(sortedChain, c);
      }
    }

    return Array.from(uniqueCycles.values());
  }

  private calculateHotspots(nodes: Record<string, GraphNode>): GraphHotspot[] {
    const hotspots = Object.values(nodes)
      .map(n => ({
        filePath: n.filePath,
        moduleName: n.moduleName,
        inDegree: n.inDegree,
      }))
      .filter(h => h.inDegree > 0)
      .sort((a, b) => b.inDegree - a.inDegree)
      .slice(0, 20); // Top 20 hotspots
    
    return hotspots;
  }
}
