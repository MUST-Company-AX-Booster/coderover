import { Injectable, Logger } from '@nestjs/common';
import {
  countCredentialMatches,
  redactCredentials,
} from '../ingest/credential-redactor.service';

/**
 * Phase 4A (Zero Trust): post-LLM response validator.
 *
 * Threats we close:
 *
 *   - The LLM regurgitates a credential it ingested earlier (legitimately
 *     present in source, or accidentally leaked into context). Today the
 *     chunker scrubs at ingest time (Phase 3C), but a sufficiently old
 *     pgvector entry, a context window that includes user-supplied text,
 *     or a model that hallucinates a real-looking key all bypass that.
 *
 *   - The LLM emits a response so large it crashes the client / rendering
 *     pipeline (length cap).
 *
 *   - Future hooks for prompt-injection detection markers (sentinel
 *     phrases, expected JSON shape, etc.) — kept as comments so the next
 *     iteration knows where to extend.
 *
 * Returns a structured result instead of throwing on credential matches:
 * we want chat to continue with a redacted response rather than failing
 * outright. The `redactedCount` lets the caller log / surface the event.
 */

export interface LLMResponseValidationResult {
  /** Sanitized response — credentials replaced with [REDACTED:<TYPE>]. */
  sanitized: string;
  /**
   * Per-type count of credential patterns redacted from the response.
   * Empty object when nothing matched. Useful for ops alerting (sustained
   * non-zero counts probably indicate prompt-injection or context-window
   * pollution).
   */
  redactions: Record<string, number>;
  /** Total characters in the response BEFORE truncation/redaction. */
  originalLength: number;
  /** Whether the response was truncated to fit `maxLength`. */
  truncated: boolean;
}

export interface ValidatorOptions {
  /**
   * Hard cap on returned response length in characters. Anything above
   * this is truncated with a `...[truncated by LLM guard]` marker. Set
   * generously — the goal is to catch runaway model output, not to
   * censor legitimate long answers. Default: 100KB.
   */
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 100_000;
const TRUNCATION_MARKER = '\n\n…[truncated by LLM guard]';

@Injectable()
export class LLMResponseValidatorService {
  private readonly logger = new Logger(LLMResponseValidatorService.name);

  /**
   * Validate + sanitize an LLM response. Always returns a result —
   * never throws on credential matches (we redact and continue).
   */
  validate(response: string, options: ValidatorOptions = {}): LLMResponseValidationResult {
    if (typeof response !== 'string') {
      // Defensive — callers should always pass a string, but if they
      // pass null/undefined treat as empty. Throwing here would mask
      // an upstream stream-handling bug behind a 503.
      response = String(response ?? '');
    }

    const originalLength = response.length;
    const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

    // 1. Length cap — truncate before redaction so we don't waste
    //    regex work on bytes we'll throw away anyway.
    let truncated = false;
    let working = response;
    if (working.length > maxLength) {
      working = working.slice(0, maxLength) + TRUNCATION_MARKER;
      truncated = true;
      this.logger.warn(
        `LLM response truncated: ${originalLength} chars > ${maxLength} cap`,
      );
    }

    // 2. Credential scrub — same curated patterns the chunker uses for
    //    pre-embedding redaction (Phase 3C). Counted before replacement
    //    so we can log/alert on findings.
    const redactions = countCredentialMatches(working);
    const sanitized = redactCredentials(working);

    const total = Object.values(redactions).reduce((a, b) => a + b, 0);
    if (total > 0) {
      this.logger.warn(
        `LLM response had ${total} credential pattern(s) redacted: ${Object.entries(redactions)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
      );
    }

    return { sanitized, redactions, originalLength, truncated };
  }
}
