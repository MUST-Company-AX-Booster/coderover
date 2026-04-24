import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import { Repo } from '../entities/repo.entity';
import { ChunkerService } from '../ingest/chunker.service';
import { EmbedderService } from '../ingest/embedder.service';
import { LanguageDetectorService } from '../ingest/languages/language-detector.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { ArtifactType } from '../artifacts/context-artifact.entity';

export interface WatchSession {
  repoId: string;
  localPath: string;
  unsubscribe: () => Promise<void>;
  framework: string | null;
  filesWatched: number;
}

@Injectable()
export class FileWatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(FileWatcherService.name);
  private readonly activeSessions = new Map<string, WatchSession>();
  private watcher: any = null;
  private isEnabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Repo)
    private readonly repoRepository: Repository<Repo>,
    private readonly chunkerService: ChunkerService,
    private readonly embedderService: EmbedderService,
    private readonly languageDetector: LanguageDetectorService,
    private readonly artifactsService: ArtifactsService,
    private readonly dataSource: DataSource,
  ) {
    this.isEnabled = this.configService.get<string>('FILE_WATCH_ENABLED', 'false') === 'true';
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopAll();
  }

  /**
   * Start watching a local directory for file changes.
   * On change: re-chunk and re-embed the modified file.
   * On delete: remove chunks for that file.
   */
  async startWatching(repoId: string, localPath: string, framework?: string): Promise<void> {
    if (!this.isEnabled) {
      this.logger.warn('File watching is disabled. Set FILE_WATCH_ENABLED=true to enable.');
      return;
    }

    if (this.activeSessions.has(repoId)) {
      this.logger.warn(`Already watching repo ${repoId}. Stop first.`);
      return;
    }

    const absolutePath = path.resolve(localPath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Path does not exist: ${absolutePath}`);
    }

    try {
      const parcelWatcher = await import('@parcel/watcher');

      this.logger.log(`Starting file watcher for ${absolutePath} (repo=${repoId})`);

      const subscription = await parcelWatcher.subscribe(
        absolutePath,
        async (err: Error | null, events: Array<{ type: string; path: string }>) => {
          if (err) {
            this.logger.error(`Watcher error for ${absolutePath}: ${err.message}`);
            return;
          }
          await this.handleFileEvents(repoId, absolutePath, events, framework ?? null);
        },
        {
          ignore: [
            'node_modules',
            '.git',
            'dist',
            '.next',
            'coverage',
            '**/*.spec.ts',
            '**/*.test.ts',
          ],
        },
      );

      const session: WatchSession = {
        repoId,
        localPath: absolutePath,
        unsubscribe: () => subscription.unsubscribe(),
        framework: framework ?? null,
        filesWatched: 0,
      };

      this.activeSessions.set(repoId, session);
      this.logger.log(`File watcher active for repo ${repoId} at ${absolutePath}`);
    } catch (err) {
      this.logger.error(`Failed to start file watcher: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Stop watching a specific repo.
   */
  async stopWatching(repoId: string): Promise<void> {
    const session = this.activeSessions.get(repoId);
    if (!session) return;

    await session.unsubscribe();
    this.activeSessions.delete(repoId);
    this.logger.log(`Stopped file watcher for repo ${repoId}`);
  }

  /**
   * Stop all active watchers.
   */
  async stopAll(): Promise<void> {
    for (const [repoId] of this.activeSessions) {
      await this.stopWatching(repoId);
    }
  }

  /**
   * List all active watch sessions.
   */
  getActiveSessions(): Array<{ repoId: string; localPath: string; framework: string | null }> {
    return [...this.activeSessions.values()].map((s) => ({
      repoId: s.repoId,
      localPath: s.localPath,
      framework: s.framework,
    }));
  }

  private async handleFileEvents(
    repoId: string,
    rootPath: string,
    events: Array<{ type: string; path: string }>,
    framework: string | null,
  ): Promise<void> {
    // Deduplicate by path, keeping the last event per file
    const deduped = new Map<string, { type: string; path: string }>();
    for (const event of events) {
      deduped.set(event.path, event);
    }

    for (const event of deduped.values()) {
      const relativePath = path.relative(rootPath, event.path).replace(/\\/g, '/');
      const artifactType = this.artifactsService.isArtifact(relativePath);

      if (artifactType) {
        if (event.type === 'delete') {
          await this.deleteArtifact(repoId, relativePath);
        } else {
          await this.reindexArtifact(repoId, event.path, relativePath, artifactType);
        }
      }

      if (!this.chunkerService.shouldIndex(relativePath)) continue;

      if (event.type === 'delete') {
        await this.deleteFileChunks(repoId, relativePath);
        this.logger.log(`[Watcher] Deleted chunks for ${relativePath}`);
      } else {
        // create or update
        await this.reindexFile(repoId, event.path, relativePath, framework);
        this.logger.log(`[Watcher] Reindexed ${relativePath}`);
      }
    }
  }

  private async reindexFile(
    repoId: string,
    absolutePath: string,
    relativePath: string,
    framework: string | null,
  ): Promise<void> {
    try {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      const commitSha = `local-${Date.now()}`;

      const chunks = this.chunkerService.chunkFile({
        filePath: relativePath,
        content,
        commitSha,
        framework: framework as any,
      });

      if (chunks.length === 0) return;

      // Delete existing chunks for this file
      await this.deleteFileChunks(repoId, relativePath);

      // Embed and upsert new chunks
      await this.embedderService.embedAndUpsert(chunks, repoId);
    } catch (err) {
      this.logger.warn(
        `Failed to reindex ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async reindexArtifact(
    repoId: string,
    absolutePath: string,
    relativePath: string,
    artifactType: ArtifactType,
  ): Promise<void> {
    try {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      await this.artifactsService.upsertArtifacts([
        {
          repoId,
          artifactType,
          filePath: relativePath,
          content,
          commitSha: `local-${Date.now()}`,
        },
      ]);
    } catch (err) {
      this.logger.warn(
        `Failed to reindex artifact ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async deleteFileChunks(repoId: string, filePath: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM code_chunks WHERE file_path = $1 AND repo_id = $2`,
      [filePath, repoId],
    );
  }

  private async deleteArtifact(repoId: string, filePath: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM context_artifacts WHERE file_path = $1 AND repo_id = $2`,
      [filePath, repoId],
    );
  }
}
