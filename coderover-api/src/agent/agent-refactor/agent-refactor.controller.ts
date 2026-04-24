import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AgentRefactorService } from './agent-refactor.service';
import { AgentService } from '../agent.service';
import { AgentTrigger, AgentType } from '../../entities/agent-run.entity';

@ApiTags('agent-refactor')
@Controller('agent/refactor')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AgentRefactorController {
  constructor(
    private readonly refactorService: AgentRefactorService,
    private readonly agentService: AgentService,
  ) {}

  @Post('scan')
  @ApiOperation({ summary: 'Trigger code smell scan' })
  @HttpCode(HttpStatus.OK)
  async scanRepo(@Body() body: { repoId: string }) {
    return this.refactorService.scanRepo(body.repoId, AgentTrigger.MANUAL);
  }

  @Get('suggestions/:repoId')
  @ApiOperation({ summary: 'List refactoring suggestions (from latest run)' })
  async getSuggestions(@Param('repoId') repoId: string) {
    const runs = await this.agentService.listRuns(repoId, 1, AgentType.REFACTOR);
    if (runs.length === 0) return [];
    
    return runs[0].metadata?.suggestions || [];
  }

  @Post('fix/:repoId/:suggestionId')
  @ApiOperation({ summary: 'Request fix for a suggestion' })
  async requestFix(@Param('repoId') repoId: string, @Param('suggestionId') suggestionId: string) {
      return this.refactorService.requestFix(repoId, suggestionId);
  }
}
