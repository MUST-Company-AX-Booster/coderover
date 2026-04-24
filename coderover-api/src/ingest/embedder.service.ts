import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { ChunkResult } from './chunker.service';
import { createLocalEmbeddings, resolveLlmBaseUrl, resolveLlmProvider } from '../config/openai.config';
import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { computeEdgeId, computeNodeId } from '../graph/deterministic-ids';

export interface EmbedResult {
  chunksProcessed: number;
  chunksUpserted: number;
  chunksDeleted: number;
  errors: string[];
  durationMs: number;
}

/** Batch size for parallel OpenAI embedding requests */
const BATCH_SIZE = 20;

/** Max retry attempts for OpenAI API errors */
const MAX_RETRIES = 3;

/** Initial retry delay in milliseconds */
const INITIAL_RETRY_DELAY_MS = 1000;

export class EmbeddingDimensionMismatchError extends Error {
  readonly expectedDimensions: number;
  readonly actualDimensions: number;

  constructor(expectedDimensions: number, actualDimensions: number) {
    super(`Expected ${expectedDimensions} dimensions, not ${actualDimensions}`);
    this.expectedDimensions = expectedDimensions;
    this.actualDimensions = actualDimensions;
  }
}

@Injectable()
export class EmbedderService {
  private readonly logger = new Logger(EmbedderService.name);
  /** Label written into `edge_producer_audit.producer` for ingest-time rows. */
  static readonly AST_INGEST_PRODUCER = 'ast:ingest-embedder';
  private readonly openai: OpenAI;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number;
  private resolvedEmbeddingDimensions: number | undefined;
  private readonly llmProvider: 'openai' | 'openrouter' | 'local';

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    @InjectRepository(EdgeProducerAudit)
    private readonly edgeAuditRepo: Repository<EdgeProducerAudit>,
    private readonly confidenceTagger: ConfidenceTaggerService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const configuredBaseURL = this.configService.get<string>('OPENAI_BASE_URL');
    this.llmProvider = resolveLlmProvider(
      this.configService.get<string>('LLM_PROVIDER'),
      apiKey,
      configuredBaseURL,
    );
    const baseURL = resolveLlmBaseUrl(this.llmProvider, configuredBaseURL, apiKey, 'embeddings');

    this.openai = new OpenAI({
      apiKey,
      baseURL,
    });
    const defaultEmbeddingModel = apiKey?.startsWith('sk-or-')
      ? 'openai/text-embedding-3-large'
      : 'text-embedding-3-large';

    this.embeddingModel =
      this.configService.get<string>('OPENAI_EMBEDDING_MODEL') || defaultEmbeddingModel;
    const configuredDimensions = Number(this.configService.get('OPENAI_EMBEDDING_DIMENSIONS'));
    this.embeddingDimensions =
      Number.isFinite(configuredDimensions) && configuredDimensions > 0 ? configuredDimensions : 1536;
  }

  private async resolveEmbeddingDimensions(): Promise<number> {
    if (this.resolvedEmbeddingDimensions) return this.resolvedEmbeddingDimensions;

    try {
      const result = await this.dataSource.query(
        `
          SELECT a.atttypmod AS typmod, pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted
          FROM pg_attribute a
          JOIN pg_class c ON a.attrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE n.nspname = 'public'
            AND c.relname = 'code_chunks'
            AND a.attname = 'embedding'
            AND a.attisdropped = false
          LIMIT 1
        `,
      );

      const typmod = Number(result?.[0]?.typmod);
      const formatted = String(result?.[0]?.formatted ?? '');
      const match = formatted.match(/vector\((\d+)\)/);
      const inferredFromFormatted = match ? Number(match[1]) : undefined;
      const inferred =
        Number.isFinite(inferredFromFormatted) && (inferredFromFormatted as number) > 0
          ? (inferredFromFormatted as number)
          : Number.isFinite(typmod) && typmod > 0
            ? typmod
            : undefined;
      if (typeof inferred === 'number' && inferred > 0) {
        this.resolvedEmbeddingDimensions = inferred;
        if (this.embeddingDimensions !== inferred) {
          this.logger.warn(
            `OPENAI_EMBEDDING_DIMENSIONS=${this.embeddingDimensions} does not match DB embedding dimensions=${inferred}. Using DB value.`,
          );
        }
        return inferred;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to infer embedding dimensions from DB: ${err instanceof Error ? err.message : String(err)}. Falling back to OPENAI_EMBEDDING_DIMENSIONS=${this.embeddingDimensions}.`,
      );
    }

    this.resolvedEmbeddingDimensions = this.embeddingDimensions;
    return this.embeddingDimensions;
  }

  /**
   * Generate embeddings for all chunks and upsert them into the code_chunks table.
   * Processes in batches of 20 with exponential backoff retry.
   */
  async embedAndUpsert(
    chunks: ChunkResult[],
    repoId?: string,
    existingFilePaths?: Set<string>,
  ): Promise<EmbedResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let chunksUpserted = 0;
    const expectedDimensions = await this.resolveEmbeddingDimensions();

    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchStart = batchIdx * BATCH_SIZE;
      const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);
      const batchNum = batchIdx + 1;

      this.logger.log(
        `Embedding batch ${batchNum}/${totalBatches} (${batchStart + batch.length} chunks)...`,
      );

      try {
        const { embeddings, dimensions } = await this.getEmbeddingsWithRetry(
          batch.map((c) => c.chunkText),
        );

        for (let i = 0; i < batch.length; i++) {
          try {
            const embedding = dimensions === expectedDimensions ? embeddings[i] : null;
            await this.upsertChunk(batch[i], embedding, repoId);
            chunksUpserted++;
          } catch (err) {
            const msg = `Failed to upsert chunk ${batch[i].filePath}:${batch[i].lineStart}: ${err instanceof Error ? err.message : String(err)}`;
            this.logger.error(msg);
            errors.push(msg);
          }
        }
      } catch (err) {
        const msg = `Batch ${batchNum} embedding failed: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error(msg);
        errors.push(msg);
        // Stop the whole run if dimensions don't match — null embeddings at
        // a wrong dim are pointless.
        if (err instanceof EmbeddingDimensionMismatchError) {
          break;
        }
        // 2026-04-16 DX fix: degrade to BM25-only for ANY provider, not just
        // local. Previously if OpenRouter / OpenAI had a hiccup, ingestion
        // produced 0 chunks and search was dead. Now we upsert chunks with
        // embedding=null and let BM25 full-text search carry the load until
        // embeddings come back (backfill worker re-runs).
        this.logger.warn(
          `Embedding API unavailable — upserting batch ${batchNum} with null embeddings (BM25-only fallback). Backfill later.`,
        );
        for (const chunk of batch) {
          try {
            await this.upsertChunk(chunk, null, repoId);
            chunksUpserted++;
          } catch (upsertErr) {
            const upsertMsg = `Failed to upsert chunk ${chunk.filePath}:${chunk.lineStart}: ${upsertErr instanceof Error ? upsertErr.message : String(upsertErr)}`;
            this.logger.error(upsertMsg);
            errors.push(upsertMsg);
          }
        }
      }
    }

    // Delete orphaned chunks
    let chunksDeleted = 0;
    if (existingFilePaths && existingFilePaths.size > 0) {
      const ingestedPaths = new Set(chunks.map((c) => c.filePath));
      const deletedPaths = [...existingFilePaths].filter((p) => !ingestedPaths.has(p));

      if (deletedPaths.length > 0) {
        chunksDeleted = await this.deleteOrphanedChunks(deletedPaths, repoId);
      }
    }

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Embedding complete: ${chunksUpserted} upserted, ${chunksDeleted} deleted, ${errors.length} errors in ${durationMs}ms`,
    );

    return {
      chunksProcessed: chunks.length,
      chunksUpserted,
      chunksDeleted,
      errors,
      durationMs,
    };
  }

  /**
   * Call OpenAI Embeddings API with exponential backoff retry.
   * Returns embedding vectors and their dimensionality.
   */
  async getEmbeddingsWithRetry(texts: string[]): Promise<{ embeddings: number[][]; dimensions: number }> {
    let lastError: Error | undefined;
    const dimensions = await this.resolveEmbeddingDimensions();
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = this.llmProvider === 'local'
          ? await createLocalEmbeddings({
              apiKey,
              baseUrl: this.configService.get<string>('OPENAI_BASE_URL'),
              model: this.embeddingModel,
              input: texts,
            })
          : await this.openai.embeddings.create({
              model: this.embeddingModel,
              input: texts,
              dimensions,
            });

        const embeddings = response.data
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);

        const actualDimensions = embeddings[0]?.length ?? 0;
        if (embeddings.length !== texts.length) {
          throw new Error(`Expected ${texts.length} embeddings, got ${embeddings.length}`);
        }

        for (const emb of embeddings) {
          if (emb.length !== actualDimensions) {
            throw new Error(`Embedding dimension mismatch in batch: ${actualDimensions} vs ${emb.length}`);
          }
        }

        if (this.llmProvider !== 'local') {
          if (actualDimensions !== dimensions) {
            throw new EmbeddingDimensionMismatchError(dimensions, actualDimensions);
          }
        } else {
          if (actualDimensions !== dimensions) {
            this.logger.warn(
              `Local embedding provider returned dimensions=${actualDimensions} but DB expects ${dimensions}. Storing chunks without embeddings.`,
            );
          }
        }

        return { embeddings, dimensions: actualDimensions };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError instanceof EmbeddingDimensionMismatchError) {
          throw lastError;
        }
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        this.logger.warn(
          `OpenAI embedding attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }

    throw lastError || new Error('Embedding failed after max retries');
  }

  /**
   * Convert a float array to pgvector string format and upsert the chunk.
   * Includes structural metadata columns (symbols, imports, nest_role, exports).
   */
  async upsertChunk(chunk: ChunkResult, embedding: number[] | null, repoId?: string): Promise<void> {
    const dimensions = await this.resolveEmbeddingDimensions();
    const vectorStr = embedding ? this.toPgVectorString(embedding) : null;
    if (embedding && embedding.length !== dimensions) {
      throw new EmbeddingDimensionMismatchError(dimensions, embedding.length);
    }
    const id = uuidv4();

    await this.dataSource.query(
      `INSERT INTO code_chunks (id, file_path, module_name, chunk_text, embedding, commit_sha, line_start, line_end, repo_id, symbols, imports, nest_role, exports, language, framework)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15)
       ON CONFLICT (repo_id, file_path, line_start, line_end)
       DO UPDATE SET chunk_text = EXCLUDED.chunk_text, embedding = EXCLUDED.embedding, commit_sha = EXCLUDED.commit_sha,
                     symbols = EXCLUDED.symbols, imports = EXCLUDED.imports, nest_role = EXCLUDED.nest_role, exports = EXCLUDED.exports,
                     language = EXCLUDED.language, framework = EXCLUDED.framework`,
      [
        id,
        chunk.filePath,
        chunk.moduleName,
        chunk.chunkText,
        vectorStr,
        chunk.commitSha,
        chunk.lineStart,
        chunk.lineEnd,
        repoId ?? null,
        JSON.stringify(chunk.symbols ?? []),
        JSON.stringify(chunk.imports ?? []),
        chunk.nestRole ?? null,
        JSON.stringify(chunk.exports ?? []),
        (chunk as any).language ?? null,
        (chunk as any).framework ?? null,
      ],
    );

    // Phase 7: Persist entity graph data
    // Only persist if repoId is present (skips for unregistered repos if any)
    if (repoId) {
      const methods = (chunk as any).methods || [];
      const callSites = (chunk as any).callSites || [];
      const inheritance = (chunk as any).inheritance || [];

      if (methods.length > 0) {
        for (const m of methods) {
          await this.dataSource.query(
            `INSERT INTO code_methods (repo_id, file_path, class_name, method_name, start_line, end_line, parameters)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [repoId, chunk.filePath, m.className, m.name, m.startLine, m.endLine, JSON.stringify(m.parameters)]
          );
          // Phase 10 B2: audit row for the Class -> Method DEFINES edge the
          // graph sync will later MERGE. AST-derived → EXTRACTED.
          await this.recordEdgeAudit({
            srcFilePath: chunk.filePath,
            srcSymbolKind: 'class',
            srcQualifiedName: m.className,
            dstFilePath: chunk.filePath,
            dstSymbolKind: 'method',
            dstQualifiedName: `${m.className}.${m.name}`,
            relationKind: 'DEFINES',
            refs: {
              source: 'code_methods',
              repoId,
              filePath: chunk.filePath,
              className: m.className,
              methodName: m.name,
              startLine: m.startLine,
              endLine: m.endLine,
            },
          });
        }
      }

      if (callSites.length > 0) {
        for (const c of callSites) {
          await this.dataSource.query(
            `INSERT INTO code_calls (repo_id, caller_file, caller_name, caller_kind, callee_name, callee_qualified, call_line)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [repoId, chunk.filePath, c.callerName, c.callerKind, c.calleeName, c.calleeQualified, c.line]
          );
          await this.recordEdgeAudit({
            srcFilePath: chunk.filePath,
            srcSymbolKind: c.callerKind ?? 'function',
            srcQualifiedName: c.callerName,
            dstFilePath: '',
            dstSymbolKind: 'callee',
            dstQualifiedName: c.calleeQualified ?? c.calleeName,
            relationKind: 'CALLS',
            refs: {
              source: 'code_calls',
              repoId,
              callerFile: chunk.filePath,
              callerName: c.callerName,
              callerKind: c.callerKind ?? null,
              calleeName: c.calleeName,
              calleeQualified: c.calleeQualified ?? null,
              line: c.line,
            },
          });
        }
      }

      if (inheritance.length > 0) {
        for (const inh of inheritance) {
          await this.dataSource.query(
            `INSERT INTO code_inheritance (repo_id, file_path, class_name, extends_class, implements_interfaces)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [repoId, chunk.filePath, inh.className, inh.extends, JSON.stringify(inh.implements)]
          );
          if (inh.extends) {
            await this.recordEdgeAudit({
              srcFilePath: chunk.filePath,
              srcSymbolKind: 'class',
              srcQualifiedName: inh.className,
              dstFilePath: '',
              dstSymbolKind: 'class',
              dstQualifiedName: inh.extends,
              relationKind: 'INHERITS',
              refs: {
                source: 'code_inheritance',
                repoId,
                filePath: chunk.filePath,
                className: inh.className,
                extendsClass: inh.extends,
              },
            });
          }
        }
      }
    }
  }

  /**
   * Phase 10 B2 — record an `edge_producer_audit` row for an AST-derived
   * edge produced by ingest. Always AST → EXTRACTED via the tagger. Failures
   * are swallowed — audit visibility must not block chunk persistence.
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
        producer: EmbedderService.AST_INGEST_PRODUCER,
        producerKind: 'ast',
        refs: params.refs ?? null,
      });

      await this.edgeAuditRepo.insert({
        edgeId,
        relationKind: params.relationKind,
        producer: EmbedderService.AST_INGEST_PRODUCER,
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

  /** Convert a float array to pgvector string format: [0.1, 0.2, ...] */
  toPgVectorString(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }

  /** Delete chunks whose file_path is in the provided list (files removed from repo) */
  private async deleteOrphanedChunks(filePaths: string[], repoId?: string): Promise<number> {
    if (filePaths.length === 0) return 0;

    const placeholders = filePaths.map((_, i) => `$${i + 1}`).join(', ');
    const repoClause = repoId
      ? ` AND repo_id = $${filePaths.length + 1}`
      : ' AND repo_id IS NULL';
    const params = repoId ? [...filePaths, repoId] : filePaths;
    const result = await this.dataSource.query(
      `DELETE FROM code_chunks WHERE file_path IN (${placeholders})${repoClause}`,
      params,
    );

    const deleted = Array.isArray(result) ? result.length : (result?.affected ?? 0);
    this.logger.log(`Deleted ${deleted} orphaned chunks from ${filePaths.length} removed files`);
    return typeof deleted === 'number' ? deleted : 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
