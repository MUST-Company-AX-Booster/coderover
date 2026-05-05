import { Module } from '@nestjs/common';
import { LLMKillSwitchService } from './llm-kill-switch.service';
import { LLMResponseValidatorService } from './llm-response-validator.service';

/**
 * Phase 4A: shared LLM-guard primitives — kill switch + response validator.
 *
 * Imported by any feature module whose service makes outbound LLM calls
 * (CopilotService, EmbedderService, PrReviewService, AgentRefactorService,
 * etc.). Initial integration is the user-facing copilot/chat surface; the
 * other call sites are wired in subsequent PRs.
 */
@Module({
  providers: [LLMKillSwitchService, LLMResponseValidatorService],
  exports: [LLMKillSwitchService, LLMResponseValidatorService],
})
export class LLMGuardModule {}
