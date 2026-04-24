import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
  forwardRef,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AgentOrchestratorService } from 'src/agent/agent-orchestrator/agent-orchestrator.service';
import { AgentApprovalService } from './agent-approval.service';
import { AgentApprovalStatus } from '../../entities/agent-approval.entity';

@ApiTags('agent-approval')
@Controller('agent/approval')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AgentApprovalController {
  constructor(
    @Inject(forwardRef(() => AgentOrchestratorService))
    private readonly orchestratorService: AgentOrchestratorService,
    private readonly approvalService: AgentApprovalService,
  ) {}

  @Get('pending')
  @ApiOperation({ summary: 'List pending approvals' })
  async getPending(@Query('repoId') repoId?: string) {
    return this.approvalService.getPendingApprovals(repoId);
  }

  @Post(':token/approve')
  @ApiOperation({ summary: 'Approve a pending action' })
  @HttpCode(HttpStatus.OK)
  async approve(@Param('token') token: string) {
    const approval = await this.approvalService.getApproval(token);
    if (!approval) throw new BadRequestException('Invalid token');
    if (approval.status !== AgentApprovalStatus.PENDING) throw new ConflictException('Already decided');
    
    await this.approvalService.updateStatus(approval.id, AgentApprovalStatus.APPROVED, 'user');
    
    const result = await this.orchestratorService.handleApproval(approval.id);
    
    return { message: 'Approved and executed', result };
  }

  @Post(':token/reject')
  @ApiOperation({ summary: 'Reject a pending action' })
  @HttpCode(HttpStatus.OK)
  async reject(@Param('token') token: string) {
    const approval = await this.approvalService.getApproval(token);
    if (!approval) throw new BadRequestException('Invalid token');
    if (approval.status !== AgentApprovalStatus.PENDING) throw new ConflictException('Already decided');
    
    await this.approvalService.updateStatus(approval.id, AgentApprovalStatus.REJECTED, 'user');
    
    return { message: 'Rejected' };
  }
}
