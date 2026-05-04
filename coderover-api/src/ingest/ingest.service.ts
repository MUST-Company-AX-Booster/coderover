import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { GitHubTokenResolver } from '../github-integration/github-token-resolver.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncLog } from '../entities/sync-log.entity';
import { Repo } from '../entities/repo.entity';
import { ChunkerService, FileToChunk, ChunkResult } from './chunker.service';
import { EmbedderService, EmbedResult } from './embedder.service';
import { GitHubService } from './github.service';
import { IngestStatusDto } from './dto/ingest-status.dto';
import { TriggerIngestDto } from './dto/trigger-ingest.dto';
import { LanguageDetectorService } from './languages/language-detector.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { ArtifactType } from '../artifacts/context-artifact.entity';
import { GraphService } from '../graph/graph.service';
import { RepoService } from '../repo/repo.service';
import { EventsService } from '../events/events.service';
import { MetricsService } from '../observability/metrics.service';

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepository: Repository<SyncLog>,
    @InjectRepository(Repo)
    private readonly repoRepository: Repository<Repo>,
    private readonly chunkerService: ChunkerService,
    private readonly embedderService: EmbedderService,
    private readonly githubService: GitHubService,
    private readonly tokenResolver: GitHubTokenResolver,
    private readonly languageDetector: LanguageDetectorService,
    private readonly artifactsService: ArtifactsService,
    private readonly graphService: GraphService,
    @Inject(forwardRef(() => RepoService))
    private readonly repoService: RepoService,
    private readonly eventsService: EventsService,
    private readonly metricsService: MetricsService,
  ) {}

  private emitProgress(repoId: string | undefined, stage: string, extra: Record<string, unknown> = {}): void {
    if (!repoId) return;
    this.eventsService.publish(`repo:${repoId}`, 'ingest.progress', { repoId, stage, ...extra });
  }

  /**
   * Orchestrate the full ingestion pipeline:
   * GitHub fetch -> chunk -> embed -> upsert -> sync_log update
   */
  async processIngestion(dto: TriggerIngestDto): Promise<IngestStatusDto> {
    // Resolve repo entity (prefer repoId, otherwise by full repo name)
    let repoEntity: Repo | null = null;
    
    if (dto.repoId) {
      repoEntity = await this.repoRepository.findOne({ where: { id: dto.repoId } });
      if (!repoEntity) {
        throw new NotFoundException(`Repo ${dto.repoId} not found`);
      }
    } else {
      const defaultRepo = await this.repoService.getDefaultRepo();
      const requestedRepo = dto.repo 
        ? this.normalizeRepoFullName(dto.repo) 
        : defaultRepo?.fullName;

      if (!requestedRepo) {
        throw new NotFoundException('No repository specified and no default repository found');
      }

      repoEntity = await this.repoService.ensureRepo(requestedRepo, dto.branch);
    }

    // Phase 2B: route through the token resolver so App installation tokens
    // are preferred when available, falling back to OAuth → per-repo PAT →
    // env GITHUB_TOKEN. Previously this bypassed the resolver and used the
    // legacy `repoEntity.githubToken` PAT path only.
    const token = (await this.tokenResolver.resolveFor(repoEntity)) || undefined;
    const repo = repoEntity.fullName;
    let branch = dto.branch?.trim() || repoEntity.branch || 'main';
    const forceReindex = dto.forceReindex ?? false;
    const repoId = repoEntity.id;

    this.logger.log(`Starting ingestion for ${repo}@${branch} (force=${forceReindex})`);
    this.emitProgress(repoId, 'started', { repo, branch, forceReindex });
    const ingestStart = Date.now();

    // Step 1: Get sync log entry for this repo
    let syncLog = repoId
      ? await this.syncLogRepository.findOne({ where: { repoId } })
      : await this.syncLogRepository.findOne({ where: { repo } });
    const lastCommitSha = syncLog?.lastCommitSha || null;

    // Step 2: Get current commit SHA
    let currentSha: string;
    try {
      currentSha = await this.githubService.getLatestCommitSha(repo, branch, token);
    } catch (err) {
      const shouldFallback = !dto.branch && err instanceof Error && err.message.includes('Not Found');
      if (!shouldFallback) {
        throw err;
      }

      const fallbackBranch = await this.githubService.getDefaultBranch(repo, token);
      if (!fallbackBranch || fallbackBranch === branch) {
        throw err;
      }

      this.logger.warn(`Branch ${branch} not found for ${repo}, switching to ${fallbackBranch}`);
      branch = fallbackBranch;
      repoEntity.branch = fallbackBranch;
      await this.repoRepository.save(repoEntity);
      currentSha = await this.githubService.getLatestCommitSha(repo, branch, token);
    }

    // Step 3: Check if already up to date
    if (lastCommitSha === currentSha && !forceReindex) {
      this.logger.log(`Repository ${repo} is already up to date at ${currentSha}`);
      return {
        status: 'up_to_date',
        repo,
        commitSha: currentSha,
        filesIndexed: syncLog?.filesIndexed ?? 0,
        chunksTotal: syncLog?.chunksTotal ?? 0,
        chunksUpserted: 0,
        chunksDeleted: 0,
        errors: [],
        durationMs: 0,
      };
    }

    // Step 4: Get file list
    let filePaths: string[];
    if (forceReindex || !lastCommitSha) {
      filePaths = await this.githubService.getAllFiles(repo, branch, token);
    } else {
      filePaths = await this.githubService.getChangedFiles(repo, lastCommitSha, currentSha, token);
    }

    // Step 5: Filter through chunker + separate artifact files
    const indexableFiles = filePaths.filter((fp) => this.chunkerService.shouldIndex(fp));
    const artifactFiles = filePaths.filter((fp) => this.artifactsService.isArtifact(fp) !== null);
    this.logger.log(`Found ${filePaths.length} total files, ${indexableFiles.length} indexable, ${artifactFiles.length} artifacts`);

    // Detect framework from root-level config files
    const rootFilePaths = filePaths.filter((fp) => !fp.includes('/') || fp.split('/').length <= 2);
    const fileContentsForDetection = new Map<string, string>();
    for (const fp of ['package.json', 'requirements.txt', 'pom.xml', 'build.gradle', 'go.mod'].filter(f => rootFilePaths.includes(f))) {
      try {
        const content = await this.githubService.getFileContent(repo, fp, branch, token);
        fileContentsForDetection.set(fp, content);
      } catch { /* ignore */ }
    }
    for (const signal of ['next.config.js', 'next.config.ts', 'next.config.mjs', 'vite.config.ts', 'vite.config.js', 'angular.json', 'svelte.config.js', 'nuxt.config.ts']) {
      if (rootFilePaths.some(fp => fp.endsWith(signal))) {
        try {
          const content = await this.githubService.getFileContent(repo, signal, branch, token);
          fileContentsForDetection.set(signal, content);
        } catch { /* ignore */ }
      }
    }
    const detectedFramework = this.languageDetector.detectFramework(filePaths, fileContentsForDetection);
    this.logger.log(`Detected framework: ${detectedFramework}`);

    // Step 6: Fetch file contents and chunk
    const allChunks: ChunkResult[] = [];
    let filesProcessed = 0;

    for (const filePath of indexableFiles) {
      try {
        const content = await this.githubService.getFileContent(repo, filePath, branch, token);
        const fileToChunk: FileToChunk = { filePath, content, commitSha: currentSha, framework: detectedFramework as any };
        const chunks = this.chunkerService.chunkFile(fileToChunk);
        allChunks.push(...chunks);
        filesProcessed++;
        if (filesProcessed % 10 === 0) {
          this.logger.log(`Fetching files: ${filesProcessed}/${indexableFiles.length}...`);
        }
      } catch (err) {
        this.logger.warn(
          `Failed to process ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 6b: Index context artifacts
    const artifactBatch: Array<{ repoId?: string; artifactType: ArtifactType; filePath: string; content: string; commitSha?: string }> = [];
    for (const filePath of artifactFiles) {
      try {
        const content = await this.githubService.getFileContent(repo, filePath, branch, token);
        const artifactType = this.artifactsService.isArtifact(filePath);
        if (artifactType) {
          artifactBatch.push({ repoId, artifactType, filePath, content, commitSha: currentSha });
        }
      } catch { /* ignore */ }
    }
    if (artifactBatch.length > 0) {
      const artifactResult = await this.artifactsService.upsertArtifacts(artifactBatch);
      this.logger.log(`Indexed ${artifactResult.upserted} context artifacts`);
    }

    this.logger.log(`Chunked ${filesProcessed} files into ${allChunks.length} chunks`);
    this.emitProgress(repoId, 'chunked', { filesProcessed, chunks: allChunks.length });

    // Step 7: Embed and upsert
    const existingPaths = forceReindex
      ? new Set(filePaths)
      : undefined;

    let embedResult: EmbedResult;
    if (allChunks.length > 0) {
      embedResult = await this.embedderService.embedAndUpsert(allChunks, repoId, existingPaths);
    } else {
      embedResult = {
        chunksProcessed: 0,
        chunksUpserted: 0,
        chunksDeleted: 0,
        errors: [],
        durationMs: 0,
      };
    }

    // Step 8: Update sync log
    if (!syncLog) {
      syncLog = this.syncLogRepository.create({ repo });
    }
    syncLog.lastCommitSha = currentSha;
    syncLog.filesIndexed = filesProcessed;
    syncLog.chunksTotal = allChunks.length;
    if (repoId) {
      syncLog.repoId = repoId;
    }
    await this.syncLogRepository.save(syncLog);

    this.logger.log(`Ingestion complete for ${repo}: ${embedResult.chunksUpserted} chunks upserted`);
    this.emitProgress(repoId, 'completed', {
      chunksUpserted: embedResult.chunksUpserted,
      chunksDeleted: embedResult.chunksDeleted,
      durationMs: embedResult.durationMs,
    });
    // Phase 9: emit ingest duration histogram (seconds).
    const elapsedSec = (Date.now() - ingestStart) / 1000;
    try {
      const sizeBucket = filesProcessed < 100 ? 'small' : filesProcessed < 1000 ? 'medium' : 'large';
      this.metricsService.observe('coderover_ingest_duration_seconds', elapsedSec, {
        repo,
        size_bucket: sizeBucket,
      });
    } catch {
      /* best-effort; metrics should never fail ingestion */
    }

    // Step 9: Sync graph to Memgraph
    if (repoId) {
      try {
        await this.graphService.syncRepoToMemgraph(repoId);
      } catch (err) {
        this.logger.warn(`Failed to sync to Memgraph for repo ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      status: 'completed',
      repo,
      commitSha: currentSha,
      filesIndexed: filesProcessed,
      chunksTotal: allChunks.length,
      chunksUpserted: embedResult.chunksUpserted,
      chunksDeleted: embedResult.chunksDeleted,
      errors: embedResult.errors,
      durationMs: embedResult.durationMs,
    };
  }

  /** Get current sync status for a repository */
  async getStatus(repo: string): Promise<SyncLog | null> {
    return this.syncLogRepository.findOne({ where: { repo } });
  }

  async getStatusByRepoId(repoId: string): Promise<SyncLog | null> {
    const byRepoId = await this.syncLogRepository.findOne({ where: { repoId } });
    if (byRepoId) {
      return byRepoId;
    }

    const repo = await this.repoRepository.findOne({ where: { id: repoId } });
    if (!repo) {
      return null;
    }
    return this.getStatus(repo.fullName);
  }

  /** Get knowledge base statistics */
  async getKnowledgeBaseStats(): Promise<{
    totalChunks: number;
    totalFiles: number;
    modules: string[];
    lastSyncedAt: Date | null;
    repos: Array<{ repo: string; filesIndexed: number; chunksTotal: number; syncedAt: Date }>;
  }> {
    const [totals] = await this.syncLogRepository.manager.query(`
      SELECT
        COUNT(*)::int AS "totalChunks",
        COUNT(DISTINCT file_path)::int AS "totalFiles"
      FROM code_chunks
    `);

    const modules: Array<{ module_name: string }> = await this.syncLogRepository.manager.query(`
      SELECT DISTINCT module_name FROM code_chunks
      WHERE module_name IS NOT NULL
      ORDER BY module_name
    `);

    const repos = await this.syncLogRepository.find();

    return {
      totalChunks: totals.totalChunks,
      totalFiles: totals.totalFiles,
      modules: modules.map((m) => m.module_name),
      lastSyncedAt: repos.length > 0 ? repos[0].syncedAt : null,
      repos: repos.map((r) => ({
        repo: r.repo,
        filesIndexed: r.filesIndexed,
        chunksTotal: r.chunksTotal,
        syncedAt: r.syncedAt,
      })),
    };
  }

  private normalizeRepoFullName(repoUrlOrFullName: string): string {
    return this.parseRepoUrl(repoUrlOrFullName).fullName.trim();
  }

  private parseRepoUrl(repoUrl: string): { owner: string; name: string; fullName: string } {
    let fullName = repoUrl.trim();

    const urlMatch = fullName.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (urlMatch) {
      fullName = `${urlMatch[1]}/${urlMatch[2]}`;
    }

    fullName = fullName.replace(/\.git$/, '');

    const [owner, name] = fullName.split('/');
    return { owner, name, fullName };
  }
}
