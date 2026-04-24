import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GraphService } from './graph.service';

@ApiTags('Graph Intelligence')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('graph')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get('dependencies')
  @ApiOperation({ summary: 'Get full dependency graph for a repository' })
  @ApiQuery({ name: 'repoId', required: true, description: 'Repository UUID' })
  async getDependencies(@Query('repoId') repoId: string) {
    if (!repoId) {
      throw new BadRequestException('repoId is required');
    }
    return this.graphService.buildGraph(repoId);
  }

  @Get('impact')
  @ApiOperation({ summary: 'Analyze impact of changing a specific file' })
  @ApiQuery({ name: 'repoId', required: true })
  @ApiQuery({ name: 'filePath', required: true, description: 'Target file path' })
  async getImpact(@Query('repoId') repoId: string, @Query('filePath') filePath: string) {
    if (!repoId || !filePath) {
      throw new BadRequestException('repoId and filePath are required');
    }
    const impactList = await this.graphService.analyzeImpact(repoId, filePath);
    return { target: filePath, impactCount: impactList.length, impactList };
  }

  @Get('cycles')
  @ApiOperation({ summary: 'Detect circular dependencies in a repository' })
  @ApiQuery({ name: 'repoId', required: true })
  async getCycles(@Query('repoId') repoId: string) {
    if (!repoId) {
      throw new BadRequestException('repoId is required');
    }
    const graph = await this.graphService.buildGraph(repoId);
    return { cyclesCount: graph.cycles.length, cycles: graph.cycles };
  }

  @Get('hotspots')
  @ApiOperation({ summary: 'Get architectural hotspots (most imported modules)' })
  @ApiQuery({ name: 'repoId', required: true })
  async getHotspots(@Query('repoId') repoId: string) {
    if (!repoId) {
      throw new BadRequestException('repoId is required');
    }
    const graph = await this.graphService.buildGraph(repoId);
    return { hotspots: graph.hotspots };
  }
}
