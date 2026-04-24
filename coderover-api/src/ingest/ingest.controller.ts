import { Controller, Post, Get, Body, Query, Logger, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IngestService } from './ingest.service';
import { ChunkerService } from './chunker.service';
import { GitHubService } from './github.service';
import { TriggerIngestDto } from './dto/trigger-ingest.dto';
import { RepoService } from '../repo/repo.service';

@ApiTags('ingest')
@ApiBearerAuth()
@Controller('ingest')
@UseGuards(JwtAuthGuard)
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(
    private readonly ingestService: IngestService,
    private readonly chunkerService: ChunkerService,
    private readonly githubService: GitHubService,
    private readonly repoService: RepoService,
    @InjectQueue('ingest') private readonly ingestQueue: Queue,
  ) {}

  /** Trigger an asynchronous ingestion job via the Bull queue */
  @Post('trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue asynchronous ingestion' })
  @ApiBody({
    type: TriggerIngestDto,
    examples: {
      byRepo: {
        summary: 'Queue by repo name',
        value: { repo: 'demo/codebase', branch: 'main', forceReindex: false },
      },
      byRepoId: {
        summary: 'Queue by registered repo ID',
        value: { repoId: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4' },
      },
    },
  })
  @ApiAcceptedResponse({
    description: 'Ingestion job accepted',
    schema: { example: { message: 'Ingestion job queued', jobId: '123', repo: 'demo/codebase' } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async triggerIngest(@Body() dto: TriggerIngestDto) {
    this.logger.log(`Ingestion triggered for ${dto.repo || 'default repo'}`);

    const job = await this.ingestQueue.add('trigger-ingest', dto, {
      attempts: 1,
      removeOnComplete: true,
    });

    return {
      message: 'Ingestion job queued',
      jobId: job.id,
      repo: dto.repo,
    };
  }

  /** Trigger synchronous ingestion (blocks until complete, returns full result) */
  @Post('trigger-sync')
  @ApiOperation({ summary: 'Run synchronous ingestion and return final result' })
  @ApiBody({ type: TriggerIngestDto })
  @ApiOkResponse({
    description: 'Synchronous ingestion result',
    schema: {
      example: {
        status: 'indexed',
        repo: 'demo/codebase',
        commitSha: 'deaa73e9afef0325ad95ff6ec57d89f5f89f3341',
        filesIndexed: 152,
        chunksTotal: 2280,
        chunksUpserted: 320,
        chunksDeleted: 12,
        errors: [],
        durationMs: 13654,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async triggerIngestSync(@Body() dto: TriggerIngestDto) {
    this.logger.log(`Synchronous ingestion triggered for ${dto.repo || 'default repo'}`);
    const result = await this.ingestService.processIngestion(dto);
    return result;
  }

  /** Get current ingestion/sync status for a repository */
  @Get('status')
  @ApiOperation({ summary: 'Get ingestion status for one repository' })
  @ApiQuery({
    name: 'repo',
    required: true,
    description: 'GitHub repo full name',
    example: 'demo/codebase',
  })
  @ApiOkResponse({
    description: 'Current indexing status',
    schema: {
      examples: {
        indexed: {
          value: {
            status: 'indexed',
            repo: 'demo/codebase',
            lastCommitSha: 'deaa73e9afef0325ad95ff6ec57d89f5f89f3341',
            filesIndexed: 152,
            chunksTotal: 2280,
            syncedAt: '2026-03-16T09:10:11.000Z',
          },
        },
        notIndexed: {
          value: { status: 'not_indexed', repo: 'demo/codebase' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getStatus(@Query('repo') repo: string) {
    const status = await this.ingestService.getStatus(repo);

    if (!status) {
      return { status: 'not_indexed', repo };
    }

    return {
      status: 'indexed',
      repo: status.repo,
      lastCommitSha: status.lastCommitSha,
      filesIndexed: status.filesIndexed,
      chunksTotal: status.chunksTotal,
      syncedAt: status.syncedAt,
    };
  }

  /** Get knowledge base statistics */
  @Get('stats')
  @ApiOperation({ summary: 'Get knowledge base aggregate statistics' })
  @ApiOkResponse({
    description: 'Knowledge base stats',
    schema: {
      example: {
        totalRepos: 3,
        activeRepos: 2,
        totalChunks: 4921,
        indexedFiles: 901,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getStats() {
    const stats = await this.ingestService.getKnowledgeBaseStats();
    return stats;
  }

  /** Test GitHub connectivity and repo access */
  @Get('github-test')
  @ApiOperation({ summary: 'Validate GitHub connectivity and indexable file discovery' })
  @ApiQuery({
    name: 'repo',
    required: false,
    description: 'GitHub repo full name',
    example: 'demo/codebase',
  })
  @ApiQuery({
    name: 'branch',
    required: false,
    description: 'Branch name',
    example: 'main',
  })
  @ApiOkResponse({
    description: 'Connectivity test result',
    schema: {
      examples: {
        success: {
          value: {
            success: true,
            repo: 'demo/codebase',
            branch: 'main',
            latestCommitSha: 'deaa73e9afef0325ad95ff6ec57d89f5f89f3341',
            totalFiles: 328,
            indexableFiles: 152,
            sampleFiles: ['src/main.ts', 'src/app.module.ts'],
          },
        },
        failure: {
          value: {
            success: false,
            repo: 'demo/codebase',
            error: 'Not Found',
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async testGitHub(@Query('repo') repo: string, @Query('branch') branch: string) {
    const defaultRepo = await this.repoService.getDefaultRepo();
    const targetRepo = repo || defaultRepo?.fullName || 'demo/codebase';
    const targetBranch = branch || defaultRepo?.branch || 'main';

    try {
      const sha = await this.githubService.getLatestCommitSha(targetRepo, targetBranch);
      const files = await this.githubService.getAllFiles(targetRepo, targetBranch);
      const indexable = files.filter((f) => this.chunkerService.shouldIndex(f));
      return {
        success: true,
        repo: targetRepo,
        branch: targetBranch,
        latestCommitSha: sha,
        totalFiles: files.length,
        indexableFiles: indexable.length,
        sampleFiles: indexable.slice(0, 10),
      };
    } catch (err) {
      return {
        success: false,
        repo: targetRepo,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
