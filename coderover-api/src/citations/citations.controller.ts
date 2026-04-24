import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ScopeGuard } from '../auth/guards/scope.guard';
import { RequiresScope } from '../common/decorators/scope.decorator';
import { CitationsService, EvidenceResult } from './citations.service';
import { BatchEvidenceDto } from './dto/batch-evidence.dto';

/**
 * Phase 10 B4 — `POST /citations/evidence`.
 *
 * Backs the "why?" affordance on chat citations and PR-review findings.
 * Batched by design: a chat page renders ~10 citations and N+1 per-id
 * GETs would dominate the render budget.
 *
 * Auth: JWT required. Scope: `citations:read` for MCP-scoped tokens.
 * Full-user tokens (no scope claim) pass through — see A4's ScopeGuard
 * for the bypass rule.
 */
@ApiTags('citations')
@Controller('citations')
export class CitationsController {
  constructor(private readonly citationsService: CitationsService) {}

  @Post('evidence')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, ScopeGuard)
  @RequiresScope('citations:read')
  @ApiOperation({
    summary: 'Batch-fetch evidence trails for citation/finding ids',
    description:
      'Accepts up to 100 ids. Each id may belong to either `rag_citations` or `pr_review_findings`. Returns results in input order. Missing / cross-org ids come back as `kind: "not_found"` so partial batches are still useful.',
  })
  @ApiBody({
    type: BatchEvidenceDto,
    examples: {
      default: {
        value: {
          ids: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ],
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Evidence trails keyed to input ids (same order, after dedup).',
    schema: {
      example: {
        results: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            kind: 'citation',
            tag: 'INFERRED',
            score: 0.62,
            producer: 'llm/gpt-4o-mini',
            file_path: 'src/payment/payment.service.ts',
            line_start: 42,
            line_end: 58,
            evidence: {
              upstream_audits: [
                {
                  producer: 'ast',
                  producer_kind: 'EXTRACTED',
                  producer_confidence: 1.0,
                  created_at: '2026-04-17T09:10:11.000Z',
                },
              ],
              similar_citations: [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  file_path: 'src/payment/payment.service.ts',
                  similarity: 0.91,
                },
              ],
              raw_ref: { edge_id: 'edge-abc' },
            },
          },
        ],
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async batchEvidence(
    @Body() body: BatchEvidenceDto,
    @Req() req: Request & { user?: { orgId?: string } },
  ): Promise<{ results: EvidenceResult[] }> {
    const orgId = req.user?.orgId;
    if (!orgId) {
      // Token validated but carries no orgId — can happen on pre-Phase-9
      // legacy tokens. Without an org we can't safely scope the read.
      throw new BadRequestException(
        'Request token has no orgId; re-authenticate to obtain an org-scoped session.',
      );
    }

    const results = await this.citationsService.getBatchEvidence(body.ids, orgId);
    return { results };
  }
}
