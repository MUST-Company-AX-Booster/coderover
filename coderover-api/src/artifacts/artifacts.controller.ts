import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ArtifactsService } from './artifacts.service';
import { ArtifactType } from './context-artifact.entity';

const ARTIFACT_TYPES: ArtifactType[] = ['schema', 'openapi', 'terraform', 'markdown', 'graphql', 'proto'];

@ApiTags('artifacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly artifactsService: ArtifactsService) {}

  @Get('search')
  @ApiOperation({ summary: 'Full-text search across context artifacts (schemas, OpenAPI, Terraform, docs)' })
  @ApiQuery({ name: 'q', required: true, example: 'auth middleware' })
  @ApiQuery({ name: 'repoId', required: false, example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4' })
  @ApiQuery({ name: 'type', required: false, enum: ARTIFACT_TYPES })
  @ApiQuery({ name: 'topK', required: false, example: '5' })
  @ApiOkResponse({
    description: 'Search results ordered by relevance',
    schema: {
      example: [
        {
          id: '2ef26398-0f84-44f7-bd4f-5938a19009ca',
          artifactType: 'OPENAPI',
          title: 'Auth API schema',
          score: 0.88,
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async search(
    @Query('q') query: string,
    @Query('repoId') repoId?: string,
    @Query('type') artifactType?: ArtifactType,
    @Query('topK') topK?: string,
  ) {
    return this.artifactsService.searchArtifacts(query, {
      repoId,
      artifactType,
      topK: topK ? Number(topK) : 5,
    });
  }

  @Get('list')
  @ApiOperation({ summary: 'List all context artifacts for a repo' })
  @ApiQuery({
    name: 'repoId',
    required: false,
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
    description: 'Optional repo UUID. If omitted, uses the first active repository.',
  })
  @ApiQuery({ name: 'type', required: false, enum: ARTIFACT_TYPES })
  @ApiOkResponse({
    description: 'Artifact list',
    schema: {
      example: [
        {
          id: '2ef26398-0f84-44f7-bd4f-5938a19009ca',
          artifactType: 'DOC',
          title: 'Architecture overview',
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async list(
    @Query('repoId') repoId?: string,
    @Query('type') artifactType?: ArtifactType,
  ) {
    return this.artifactsService.getArtifacts(repoId, artifactType);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get artifact count by type' })
  @ApiQuery({ name: 'repoId', required: false, example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4' })
  @ApiOkResponse({
    description: 'Artifact counters grouped by type',
    schema: {
      example: {
        OPENAPI: 3,
        DOC: 12,
        SCHEMA: 5,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async stats(@Query('repoId') repoId?: string) {
    return this.artifactsService.getArtifactStats(repoId);
  }
}
