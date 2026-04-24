import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { ContextArtifact, ArtifactType } from './context-artifact.entity';
import { Repo } from '../entities/repo.entity';

export interface ArtifactIndexResult {
  upserted: number;
  errors: string[];
  durationMs: number;
}

export interface ArtifactSearchResult {
  id: string;
  repoId: string | null;
  artifactType: string;
  filePath: string;
  content: string;
  metadata: Record<string, any> | null;
  similarity: number;
}

/** File extension → artifact type mapping */
const ARTIFACT_EXTENSIONS: Array<{ pattern: RegExp; type: ArtifactType }> = [
  // SQL / DB schemas
  { pattern: /\.(sql)$/i, type: 'schema' },
  { pattern: /schema\.(ts|js|prisma)$/i, type: 'schema' },
  { pattern: /\.(prisma)$/i, type: 'schema' },
  // OpenAPI / Swagger
  { pattern: /\.(yaml|yml)$/i, type: 'openapi' },
  { pattern: /openapi\.(json)$/i, type: 'openapi' },
  { pattern: /swagger\.(json|yaml|yml)$/i, type: 'openapi' },
  // Terraform
  { pattern: /\.(tf|tfvars)$/i, type: 'terraform' },
  // GraphQL
  { pattern: /\.(graphql|gql)$/i, type: 'graphql' },
  // Protocol Buffers
  { pattern: /\.(proto)$/i, type: 'proto' },
  // Architecture / documentation markdown
  { pattern: /^(architecture|adr|design|api|database|schema|readme)\.(md|mdx)$/i, type: 'markdown' },
  { pattern: /\/(docs?|documentation|architecture|adr)\//i, type: 'markdown' },
];

/** Paths that are definitely NOT artifacts */
const EXCLUDED_ARTIFACT_PATHS = [
  'node_modules/',
  'dist/',
  '.git/',
  'coverage/',
  'test/',
  '__tests__/',
];

@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);

  constructor(
    @InjectRepository(ContextArtifact)
    private readonly artifactRepository: Repository<ContextArtifact>,
    @InjectRepository(Repo)
    private readonly repoRepository: Repository<Repo>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Determine if a file path should be indexed as a context artifact.
   */
  isArtifact(filePath: string): ArtifactType | null {
    const lower = filePath.toLowerCase();

    // Exclude non-artifact paths
    for (const excluded of EXCLUDED_ARTIFACT_PATHS) {
      if (lower.includes(excluded.toLowerCase())) return null;
    }

    // Check against artifact patterns
    const basename = lower.split('/').pop() ?? '';

    for (const { pattern, type } of ARTIFACT_EXTENSIONS) {
      if (pattern.test(basename) || pattern.test(lower)) {
        return type;
      }
    }

    return null;
  }

  /**
   * Upsert a batch of context artifacts.
   */
  async upsertArtifacts(
    artifacts: Array<{
      repoId?: string;
      artifactType: ArtifactType;
      filePath: string;
      content: string;
      commitSha?: string;
      metadata?: Record<string, any>;
    }>,
  ): Promise<ArtifactIndexResult> {
    const start = Date.now();
    const errors: string[] = [];
    let upserted = 0;

    // Phase 9 bug fix 2026-04-16: context_artifacts.org_id is NOT NULL
    // (migration 014) but the INSERT below never set it, so every upsert
    // was failing with a NOT NULL violation — silently, via the catch
    // block, producing "Indexed 0 context artifacts" in the happy log.
    // Derive org_id from the Repo (artifacts inherit their repo's org).
    // Cache per-batch: one DB roundtrip per unique repoId, not per file.
    const uniqueRepoIds = Array.from(
      new Set(artifacts.map((a) => a.repoId).filter((id): id is string => !!id)),
    );
    const orgIdByRepo = new Map<string, string | null>();
    if (uniqueRepoIds.length > 0) {
      const repos = await this.repoRepository.find({
        where: uniqueRepoIds.map((id) => ({ id })),
        select: ['id', 'orgId'] as any,
      });
      for (const r of repos) {
        orgIdByRepo.set(r.id, (r as any).orgId ?? null);
      }
    }

    for (const artifact of artifacts) {
      try {
        const orgId = artifact.repoId ? orgIdByRepo.get(artifact.repoId) ?? null : null;
        if (!orgId) {
          // Fail fast with a clear message instead of a Postgres NOT NULL
          // violation. Happens when the Repo row predates Phase 9 org
          // assignment or was somehow created without an org.
          throw new Error(
            `cannot resolve org_id for repo ${artifact.repoId ?? '<none>'}; ` +
              `ensure the Repo row has org_id populated (Phase 9 multi-tenancy)`,
          );
        }
        await this.dataSource.query(
          `
          INSERT INTO context_artifacts
            (repo_id, artifact_type, file_path, content, commit_sha, metadata, org_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (repo_id, file_path) DO UPDATE SET
            artifact_type = EXCLUDED.artifact_type,
            content       = EXCLUDED.content,
            commit_sha    = EXCLUDED.commit_sha,
            metadata      = EXCLUDED.metadata,
            org_id        = EXCLUDED.org_id,
            updated_at    = now()
          `,
          [
            artifact.repoId ?? null,
            artifact.artifactType,
            artifact.filePath,
            artifact.content,
            artifact.commitSha ?? null,
            artifact.metadata ? JSON.stringify(artifact.metadata) : null,
            orgId,
          ],
        );
        upserted++;
      } catch (err) {
        const msg = `Failed to upsert artifact ${artifact.filePath}: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.warn(msg);
        errors.push(msg);
      }
    }

    return { upserted, errors, durationMs: Date.now() - start };
  }

  /**
   * BM25 full-text search across context_artifacts.
   */
  async searchArtifacts(
    query: string,
    options?: { repoId?: string; artifactType?: ArtifactType; topK?: number },
  ): Promise<ArtifactSearchResult[]> {
    const topK = options?.topK ?? 5;
    const params: any[] = [query, topK];
    let paramIdx = 3;

    let repoClause = '';
    if (options?.repoId) {
      repoClause = ` AND repo_id = $${paramIdx}`;
      params.push(options.repoId);
      paramIdx++;
    }

    let typeClause = '';
    if (options?.artifactType) {
      typeClause = ` AND artifact_type = $${paramIdx}`;
      params.push(options.artifactType);
      paramIdx++;
    }

    const sql = `
      SELECT
        id,
        repo_id       AS "repoId",
        artifact_type AS "artifactType",
        file_path     AS "filePath",
        content,
        metadata,
        ts_rank(chunk_tsv, plainto_tsquery('english', $1)) AS similarity
      FROM context_artifacts
      WHERE chunk_tsv @@ plainto_tsquery('english', $1)
        ${repoClause}${typeClause}
      ORDER BY similarity DESC
      LIMIT $2
    `;

    const rows: ArtifactSearchResult[] = await this.dataSource.query(sql, params);
    this.logger.debug(`Artifact search for "${query}" returned ${rows.length} results`);
    return rows;
  }

  /**
   * Get all artifacts for a repository, optionally filtered by type.
   */
  async getArtifacts(
    repoId?: string,
    artifactType?: ArtifactType,
  ): Promise<ContextArtifact[]> {
    const resolvedRepoId = await this.resolveRepoId(repoId);
    if (!resolvedRepoId) return [];

    const where = repoId
      ? [{ repoId: resolvedRepoId }]
      : [{ repoId: resolvedRepoId }, { repoId: IsNull() }];

    const typedWhere = artifactType ? where.map((w) => ({ ...w, artifactType })) : where;

    return this.artifactRepository.find({
      where: typedWhere as any,
      order: { filePath: 'ASC' },
    });
  }

  private async resolveRepoId(repoId?: string): Promise<string | null> {
    if (repoId) return repoId;
    const repos = await this.repoRepository.find({
      where: { isActive: true },
      order: { createdAt: 'ASC' },
      take: 1,
    });
    return repos[0]?.id ?? null;
  }

  /**
   * Get count of artifacts by type for a repo.
   */
  async getArtifactStats(repoId?: string): Promise<Array<{ type: string; count: number }>> {
    const params = repoId ? [repoId] : [];
    const whereClause = repoId ? 'WHERE repo_id = $1' : '';

    const rows: Array<{ artifact_type: string; count: string }> = await this.dataSource.query(
      `SELECT artifact_type, COUNT(*)::int AS count FROM context_artifacts ${whereClause} GROUP BY artifact_type ORDER BY count DESC`,
      params,
    );

    return rows.map((r) => ({ type: r.artifact_type, count: Number(r.count) }));
  }

  /**
   * Delete all artifacts for a repository.
   */
  async deleteRepoArtifacts(repoId: string): Promise<number> {
    const result = await this.artifactRepository.delete({ repoId });
    return result.affected ?? 0;
  }
}
