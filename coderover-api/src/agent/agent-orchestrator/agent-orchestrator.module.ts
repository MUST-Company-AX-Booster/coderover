import { Module, forwardRef } from '@nestjs/common';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentRefactorModule } from '../agent-refactor/agent-refactor.module';
import { AgentApprovalModule } from '../agent-approval/agent-approval.module';
import { EventsModule } from '../../events/events.module';

@Module({
  imports: [
    forwardRef(() => AgentApprovalModule),
    forwardRef(() => AgentRefactorModule),
    EventsModule,
  ],
  providers: [AgentOrchestratorService],
  exports: [AgentOrchestratorService],
})
export class AgentOrchestratorModule {}
