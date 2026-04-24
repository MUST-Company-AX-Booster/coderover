import { Injectable } from '@nestjs/common';
import type { ConfidenceTag } from '../entities/rag-citation.entity';

/**
 * Phase 10 B2 — `ConfidenceTagger` classification kinds.
 *
 * Every producer that writes a citation, finding, or graph edge declares
 * what *kind* of producer it is; the tagger maps that to a user-visible
 * `ConfidenceTag` under a single, auditable policy.
 *
 *   - `'ast'`    — rule-based extraction (tree-sitter AST, deterministic
 *                 static analysis, grep). Output is a direct observation of
 *                 the source, not a prediction.
 *   - `'llm'`    — produced by a model (embedding similarity, hybrid-search
 *                 rerank, LLM relation extraction, agent inference). Always
 *                 carries a self-reported confidence score when available.
 *   - `'hybrid'` — two or more producers contributed; score reflects their
 *                 agreement (1.0 = full agreement, 0 = complete disagreement).
 */
export type ProducerKind = 'ast' | 'llm' | 'hybrid';

/** Input to `ConfidenceTaggerService.tag`. */
export interface Evidence {
  /**
   * Human-readable producer label (e.g. `'ast:graph-sync'`,
   * `'hybrid-search'`, `'pr-review:ai'`, `'pr-review:deterministic'`).
   * Written as-is to the `producer` column on audit / citation / finding
   * rows. Used for debugging and the evidence panel — never for policy.
   */
  producer: string;

  /** See {@link ProducerKind}. */
  producerKind: ProducerKind;

  /**
   * Producer's self-reported confidence in [0, 1]. For `llm` this is the
   * model / embedding score. For `hybrid` this is the agreement score. For
   * `ast` this field is ignored (AST extraction is always 1.0).
   */
  selfScore?: number | null;

  /**
   * Free-form JSON blob written verbatim to `evidence_ref`. Typically:
   *   - For citations: `{ chunkId, similarity, model }`.
   *   - For findings:  `{ source: 'deterministic'|'ai', rule?, model? }`.
   *   - For edges:     `{ callerFile, callerName, calleeName, ... }`.
   */
  refs?: unknown;
}

export interface TagResult {
  tag: ConfidenceTag;
  /**
   * Numeric score stored alongside the tag. `null` when no meaningful score
   * is available (EXTRACTED rows with score 1.0 also use 1.0 so downstream
   * opacity renderers don't need a special-case).
   */
  score: number | null;
  /** The `refs` passthrough, normalized to `null` when absent. */
  evidence_ref: unknown;
}

/**
 * Threshold below which a hybrid producer's agreement score is treated as
 * contradictory (AMBIGUOUS rather than INFERRED). Chosen conservatively:
 * an agreement below 0.5 means the contributing producers disagree more
 * than they agree.
 */
export const HYBRID_LOW_AGREEMENT_THRESHOLD = 0.5;

/**
 * Phase 10 B2 — Single source of truth for confidence tagging.
 *
 * The only class in the codebase allowed to decide whether a producer's
 * output is `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`. Producers call
 * {@link tag} at write time and write the returned tuple into their
 * respective table / column — they never synthesize a tag themselves.
 *
 * Rules, in evaluation order:
 *
 *   1. `producerKind === 'ast'`                  → `EXTRACTED`, score 1.0.
 *   2. `producerKind === 'llm'` with finite score → `INFERRED`, score clamped
 *      to [0, 1].
 *   3. `producerKind === 'llm'` without a score   → `AMBIGUOUS` (the tagger
 *      refuses to fabricate a confidence — caller should supply one).
 *   4. `producerKind === 'hybrid'` with agreement below
 *      {@link HYBRID_LOW_AGREEMENT_THRESHOLD} → `AMBIGUOUS` with the
 *      agreement score preserved.
 *   5. `producerKind === 'hybrid'` with higher agreement → `INFERRED` with
 *      the agreement score.
 *   6. Missing / NaN / non-finite `selfScore` anywhere it was required →
 *      `AMBIGUOUS`, score `null`.
 *
 * The service is intentionally stateless and side-effect-free; it's cheap to
 * call in a hot loop during ingestion.
 */
@Injectable()
export class ConfidenceTaggerService {
  tag(evidence: Evidence): TagResult {
    const refs = evidence.refs ?? null;
    switch (evidence.producerKind) {
      case 'ast':
        return { tag: 'EXTRACTED', score: 1.0, evidence_ref: refs };
      case 'llm': {
        const score = normalizeScore(evidence.selfScore);
        if (score === null) {
          return { tag: 'AMBIGUOUS', score: null, evidence_ref: refs };
        }
        return { tag: 'INFERRED', score, evidence_ref: refs };
      }
      case 'hybrid': {
        const score = normalizeScore(evidence.selfScore);
        if (score === null) {
          return { tag: 'AMBIGUOUS', score: null, evidence_ref: refs };
        }
        if (score < HYBRID_LOW_AGREEMENT_THRESHOLD) {
          return { tag: 'AMBIGUOUS', score, evidence_ref: refs };
        }
        return { tag: 'INFERRED', score, evidence_ref: refs };
      }
      default:
        // Never reached under TypeScript — guard for JS callers / corrupted
        // inputs anyway so we never throw from the hot path.
        return { tag: 'AMBIGUOUS', score: null, evidence_ref: refs };
    }
  }
}

/**
 * Clamp a user-supplied score to [0, 1]. Returns `null` for `undefined`,
 * `null`, `NaN`, or non-finite values (e.g. `Infinity`).
 */
function normalizeScore(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
