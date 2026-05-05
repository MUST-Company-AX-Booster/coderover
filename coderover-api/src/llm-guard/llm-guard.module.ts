import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LLMAuditLog } from '../entities/llm-audit-log.entity';
import { LLMAuditService } from './llm-audit.service';
import { LLMKillSwitchService } from './llm-kill-switch.service';
import { LLMResponseValidatorService } from './llm-response-validator.service';

/**
 * Phase 4 (A + B): shared LLM-guard primitives.
 *
 *   - LLMKillSwitchService — env-gated emergency stop (Phase 4A)
 *   - LLMResponseValidatorService — credential scrub + length cap on
 *     LLM output (Phase 4A)
 *   - LLMAuditService — fire-and-forget per-call audit row (Phase 4B)
 *
 * Imported by any feature module whose service makes outbound LLM
 * calls (CopilotService, EmbedderService, PrReviewService,
 * AgentRefactorService, MCP tools). Initial integration is the
 * copilot/chat surface; the other call sites are wired in subsequent
 * PRs without touching the guard logic.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LLMAuditLog])],
  providers: [LLMKillSwitchService, LLMResponseValidatorService, LLMAuditService],
  exports: [LLMKillSwitchService, LLMResponseValidatorService, LLMAuditService],
})
export class LLMGuardModule {}
