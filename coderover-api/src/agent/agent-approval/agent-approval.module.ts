import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentApprovalService } from './agent-approval.service';
import { AgentApprovalController } from './agent-approval.controller';
import { AgentApproval } from '../../entities/agent-approval.entity';
import { AgentModule } from '../agent.module';
// AgentOrchestratorModule will import this module, so we don't import it here to avoid circular
// But Controller needs OrchestratorService? Yes.
// So we need forwardRef?
// Or put OrchestratorService in a separate module that imports everything?
// Yes, AgentOrchestratorModule imports everything.
// AgentApprovalController should be in AgentApprovalModule, but it delegates to Orchestrator.
// So AgentApprovalModule needs AgentOrchestratorModule.
// But AgentOrchestratorModule needs AgentApprovalService (from AgentApprovalModule).
// CIRCULAR!

// Solution:
// AgentApprovalService is pure data access.
// AgentApprovalController depends on AgentOrchestratorService.
// AgentOrchestratorService depends on AgentApprovalService.
// So AgentApprovalModule imports AgentOrchestratorModule (forwardRef).
// AgentOrchestratorModule imports AgentApprovalModule (forwardRef).

import { forwardRef } from '@nestjs/common';
import { AgentOrchestratorModule } from '../agent-orchestrator/agent-orchestrator.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentApproval]),
    AgentModule,
    forwardRef(() => AgentOrchestratorModule),
  ],
  controllers: [AgentApprovalController],
  providers: [AgentApprovalService],
  exports: [AgentApprovalService],
})
export class AgentApprovalModule {}
