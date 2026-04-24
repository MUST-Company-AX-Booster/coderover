import {
  Controller,
  Get,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('agent')
@Controller('agent')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get agent system status' })
  async getStatus() {
    return this.agentService.getStatus();
  }

  @Get('runs/:repoId')
  @ApiOperation({ summary: 'List agent runs for a repo' })
  async listRuns(
    @Param('repoId') repoId: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ) {
    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      const n = parseInt(limit, 10);
      if (!Number.isNaN(n)) {
        parsedLimit = n;
      }
    }

    return this.agentService.listRuns(repoId, parsedLimit, type as any);
  }
}
