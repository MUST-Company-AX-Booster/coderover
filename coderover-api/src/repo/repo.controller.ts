import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Logger,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RepoService } from './repo.service';
import { RegisterRepoDto } from './dto/register-repo.dto';
import { UpdateRepoDto } from './dto/update-repo.dto';
import { IngestService } from '../ingest/ingest.service';
import { RepoResponseDto } from './dto/repo-response.dto';

@ApiTags('repos')
@ApiBearerAuth()
@Controller('repos')
@UseGuards(JwtAuthGuard)
export class RepoController {
  private readonly logger = new Logger(RepoController.name);

  constructor(
    private readonly repoService: RepoService,
    private readonly ingestService: IngestService,
    @InjectQueue('ingest') private readonly ingestQueue: Queue,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Register a repository' })
  @ApiBody({ type: RegisterRepoDto })
  @ApiOkResponse({
    description: 'Repository registration result',
    type: RepoResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async register(@Body() dto: RegisterRepoDto) {
    this.logger.log(`Registering repo: ${dto.repoUrl}`);
    return this.repoService.register(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List repositories' })
  @ApiOkResponse({
    description: 'All repositories',
    type: RepoResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async findAll() {
    // Phase 10 (2026-04-16): map raw Repo entities through RepoResponseDto
    // so `githubToken` never leaves the backend. Surfaces `source` +
    // `hasToken` so the frontend can show "ready to ingest" badges
    // without seeing the secret itself.
    const repos = await this.repoService.findAll();
    return repos.map((repo) => RepoResponseDto.fromEntity(repo));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get repository by ID' })
  @ApiParam({
    name: 'id',
    description: 'Repository UUID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @ApiOkResponse({ type: RepoResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    const repo = await this.repoService.findById(id);
    return RepoResponseDto.fromEntity(repo);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update repository configuration' })
  @ApiParam({
    name: 'id',
    description: 'Repository UUID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @ApiBody({ type: UpdateRepoDto })
  @ApiOkResponse({ type: RepoResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRepoDto) {
    return this.repoService.updateConfig(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate repository' })
  @ApiParam({
    name: 'id',
    description: 'Repository UUID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @ApiOkResponse({
    schema: { example: { message: 'Repository deactivated' } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async deactivate(@Param('id', ParseUUIDPipe) id: string) {
    await this.repoService.deactivate(id);
    return { message: 'Repository deactivated' };
  }

  @Delete(':id/hard')
  @ApiOperation({ summary: 'Permanently delete repository and metadata' })
  @ApiParam({
    name: 'id',
    description: 'Repository UUID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @ApiOkResponse({
    schema: { example: { message: 'Repository deleted' } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async hardDelete(@Param('id', ParseUUIDPipe) id: string) {
    await this.repoService.delete(id);
    return { message: 'Repository deleted' };
  }

  @Post(':id/ingest')
  @ApiOperation({ summary: 'Queue ingestion for one registered repository' })
  @ApiParam({
    name: 'id',
    description: 'Repository UUID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @ApiAcceptedResponse({
    description: 'Ingestion queued',
    schema: {
      example: {
        message: 'Ingestion job queued',
        jobId: '123',
        repoId: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
        fullName: 'demo/codebase',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async triggerIngest(@Param('id', ParseUUIDPipe) id: string) {
    const repo = await this.repoService.findById(id);
    this.logger.log(`Triggering ingestion for repo: ${repo.fullName}`);

    const job = await this.ingestQueue.add('trigger-ingest', { repoId: repo.id, repo: repo.fullName }, {
      attempts: 1,
      removeOnComplete: true,
    });

    return {
      message: 'Ingestion job queued',
      jobId: job.id,
      repoId: repo.id,
      fullName: repo.fullName,
    };
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Get ingestion status for one registered repository' })
  @ApiParam({
    name: 'id',
    description: 'Repository UUID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @ApiOkResponse({
    description: 'Current ingestion status',
    schema: {
      examples: {
        indexed: {
          value: {
            status: 'indexed',
            repoId: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
            fullName: 'demo/codebase',
            lastCommitSha: 'deaa73e9afef0325ad95ff6ec57d89f5f89f3341',
            filesIndexed: 152,
            chunksTotal: 2280,
            syncedAt: '2026-03-16T09:10:11.000Z',
          },
        },
        notIndexed: {
          value: {
            status: 'not_indexed',
            repoId: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
            fullName: 'demo/codebase',
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getStatus(@Param('id', ParseUUIDPipe) id: string) {
    const repo = await this.repoService.findById(id);
    const status = await this.ingestService.getStatusByRepoId(repo.id);

    if (!status) {
      return { status: 'not_indexed', repoId: id, fullName: repo.fullName };
    }

    return {
      status: 'indexed',
      repoId: id,
      fullName: repo.fullName,
      lastCommitSha: status.lastCommitSha,
      filesIndexed: status.filesIndexed,
      chunksTotal: status.chunksTotal,
      syncedAt: status.syncedAt,
    };
  }
}
