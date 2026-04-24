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
import { AgentEnforcerService } from './agent-enforcer.service';
import { AgentTrigger, AgentType } from '../../entities/agent-run.entity';
import { AgentService } from '../agent.service';
import { AgentRule } from '../../entities/agent-rule.entity';

@ApiTags('agent-enforcer')
@Controller('agent/enforcer')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AgentEnforcerController {
  constructor(
    private readonly enforcerService: AgentEnforcerService,
    private readonly agentService: AgentService,
  ) {}

  @Post('enforce/:repoId')
  @ApiOperation({ summary: 'Trigger best-practice enforcement' })
  @HttpCode(HttpStatus.OK)
  async enforceRules(@Param('repoId') repoId: string) {
    return this.enforcerService.enforceRules(repoId, AgentTrigger.MANUAL);
  }

  @Get('violations/:repoId')
  @ApiOperation({ summary: 'List violations (from latest run)' })
  async getViolations(@Param('repoId') repoId: string) {
    const runs = await this.agentService.listRuns(repoId, 1, AgentType.ENFORCER);
    if (runs.length === 0) return [];
    return runs[0].metadata?.violations || [];
  }

  @Post('rules/:repoId')
  @ApiOperation({ summary: 'Create a custom rule' })
  async createRule(@Param('repoId') repoId: string, @Body() body: Partial<AgentRule>) {
    return this.enforcerService.createRule(repoId, body);
  }

  @Get('rules/:repoId')
  @ApiOperation({ summary: 'List active rules' })
  async listRules(@Param('repoId') repoId: string) {
    return this.enforcerService.listRules(repoId);
  }
}
