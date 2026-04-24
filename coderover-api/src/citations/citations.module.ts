import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { RagCitation } from '../entities/rag-citation.entity';
import { PrReviewFinding } from '../entities/pr-review-finding.entity';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { CitationsController } from './citations.controller';
import { CitationsService } from './citations.service';

/**
 * Phase 10 B4 — Citations evidence batch endpoint.
 *
 * Standalone module: readers only, no producers. Writers to
 * `rag_citations` / `pr_review_findings` live in the chat and pr-review
 * modules respectively; this module is intentionally import-light so the
 * "why?" read path has no circular-dep risk against those heavier modules.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([RagCitation, PrReviewFinding, EdgeProducerAudit]),
  ],
  controllers: [CitationsController],
  providers: [CitationsService],
  exports: [CitationsService],
})
export class CitationsModule {}
