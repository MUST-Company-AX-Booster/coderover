import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LLMAuditLog } from '../entities/llm-audit-log.entity';
import { LLMAnomalyAlertsService } from './llm-anomaly-alerts.service';
import { LLMAuditService } from './llm-audit.service';
import { LLMKillSwitchService } from './llm-kill-switch.service';
import { LLMResponseValidatorService } from './llm-response-validator.service';

/**
 * Phase 4 (A + B + C): shared LLM-guard primitives.
 *
 *   - LLMKillSwitchService       — env-gated emergency stop (Phase 4A)
 *   - LLMResponseValidatorService — credential scrub + length cap on
 *                                   LLM output (Phase 4A)
 *   - LLMAuditService            — fire-and-forget per-call audit row (Phase 4B)
 *   - LLMAnomalyAlertsService    — periodic sweep over the audit log
 *                                   that emits structured warn-level
 *                                   alerts on token spikes / sustained
 *                                   redactions / kill-switch volume
 *                                   (Phase 4C)
 *
 * Imported by any feature module whose service makes outbound LLM
 * calls (CopilotService, EmbedderService, PrReviewService,
 * AgentRefactorService, MCP tools). The anomaly service self-schedules
 * via OnModuleInit — registering this module is enough to start sweeps.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LLMAuditLog])],
  providers: [
    LLMKillSwitchService,
    LLMResponseValidatorService,
    LLMAuditService,
    LLMAnomalyAlertsService,
  ],
  exports: [
    LLMKillSwitchService,
    LLMResponseValidatorService,
    LLMAuditService,
    LLMAnomalyAlertsService,
  ],
})
export class LLMGuardModule {}
