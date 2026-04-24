import { Injectable, Logger, Inject, forwardRef, BadRequestException } from '@nestjs/common';
import { AgentApprovalService } from '../agent-approval/agent-approval.service';
import { AgentRefactorService } from '../agent-refactor/agent-refactor.service';
import { AgentApprovalStatus } from '../../entities/agent-approval.entity';
import { EventsService } from '../../events/events.service';

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    @Inject(forwardRef(() => AgentApprovalService))
    private readonly approvalService: AgentApprovalService,
    private readonly refactorService: AgentRefactorService, // No forwardRef needed here
    private readonly eventsService: EventsService,
  ) {}

  emitRunUpdate(runId: string, status: string, extra: Record<string, unknown> = {}): void {
    this.eventsService.publish(`run:${runId}`, 'agent.run.updated', { runId, status, ...extra });
  }

  async handleApproval(approvalId: string): Promise<any> {
    const approval = await this.approvalService.getApprovalById(approvalId);

    if (!approval || approval.status !== AgentApprovalStatus.APPROVED) {
      throw new BadRequestException('Approval invalid or not approved');
    }

    this.logger.log(`Executing approved action: ${approval.actionType}`);
    this.emitRunUpdate(approvalId, 'executing', { actionType: approval.actionType });

    try {
      switch (approval.actionType) {
        case 'APPLY_FIX':
          return this.refactorService.applyFix(approval.actionPayload);
        default:
          throw new BadRequestException(`Unknown action type: ${approval.actionType}`);
      }
    } catch (err) {
      this.logger.error(
        `Failed to execute action ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
