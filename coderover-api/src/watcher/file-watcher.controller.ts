import { Controller, Post, Delete, Get, Body, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FileWatcherService } from './file-watcher.service';

class StartWatchDto {
  @ApiProperty({ format: 'uuid', example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4' })
  @IsString()
  repoId!: string;

  @ApiProperty({ example: '/Users/me/projects/demo-codebase' })
  @IsString()
  localPath!: string;

  @ApiPropertyOptional({ example: 'nestjs' })
  @IsString()
  @IsOptional()
  framework?: string;
}

@ApiTags('watcher')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('watcher')
export class FileWatcherController {
  constructor(private readonly fileWatcherService: FileWatcherService) {}

  @Post('start')
  @ApiOperation({ summary: 'Start watching a local directory for live re-indexing' })
  @ApiBody({ type: StartWatchDto })
  @ApiOkResponse({
    schema: {
      example: {
        message: 'Started watching /Users/me/projects/demo-codebase for repo d8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async start(@Body() dto: StartWatchDto) {
    await this.fileWatcherService.startWatching(dto.repoId, dto.localPath, dto.framework);
    return { message: `Started watching ${dto.localPath} for repo ${dto.repoId}` };
  }

  @Delete('stop/:repoId')
  @ApiOperation({ summary: 'Stop watching a repo' })
  @ApiParam({
    name: 'repoId',
    description: 'Repository ID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @ApiOkResponse({
    schema: { example: { message: 'Stopped watching repo d8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4' } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async stop(@Param('repoId') repoId: string) {
    await this.fileWatcherService.stopWatching(repoId);
    return { message: `Stopped watching repo ${repoId}` };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List active watch sessions' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          repoId: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
          localPath: '/Users/me/projects/demo-codebase',
          startedAt: '2026-03-16T09:10:11.000Z',
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getSessions() {
    return this.fileWatcherService.getActiveSessions();
  }
}
