/**
 * Phase 3C (Zero Trust): pre-embedding credential scrub.
 *
 * Threat we're closing:
 *   When we ingest a customer repo, we tree-sitter chunk every source
 *   file and embed the chunks into pgvector. If a developer accidentally
 *   committed an AWS key, GitHub PAT, or other credential into source,
 *   that secret would land:
 *     1. in pgvector as part of an embedding
 *     2. in the LLM provider's logs during embedding generation
 *     3. retrievable via similarity search by anyone with chat access
 *
 * Defense:
 *   Run every chunk through `redactCredentials()` before it leaves the
 *   chunker. Matches are replaced with `[REDACTED:<TYPE>]`, which
 *   embed harmlessly and surface the redaction site in chat output if
 *   it is ever retrieved.
 *
 * Curation principle:
 *   ONLY high-confidence prefix patterns. We deliberately exclude:
 *     - Loose `sk-...` (matches almost any base58 string — too noisy)
 *     - Bare 40-char base64 (false positives in test fixtures, hashes)
 *     - JWT body match (legitimate test fixtures use real-looking JWTs)
 *   The cost of a false positive is corrupting a legitimate chunk —
 *   chat retrieval over that chunk would return text with `[REDACTED:*]`
 *   in place of real code. We accept lower recall in exchange.
 *
 *   When extending: prefer fixed prefixes (`xoxp-`, `ghp_`, `AKIA`) over
 *   loose entropy heuristics. Defer to a real entropy scanner (gitleaks
 *   / trufflehog with verified-only) for the long tail.
 */

interface CredentialPattern {
  /** Short uppercase identifier used in `[REDACTED:<TYPE>]`. */
  type: string;
  /** Human-readable description (kept in source as documentation). */
  description: string;
  /** RegExp with the `g` flag — matched globally across the input. */
  regex: RegExp;
}

export const CREDENTIAL_PATTERNS: ReadonlyArray<CredentialPattern> = [
  // --- AWS ---
  {
    type: 'AWS_ACCESS_KEY',
    description: 'AWS access key id (AKIA / ASIA prefixes are root + STS)',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },

  // --- GitHub ---
  {
    type: 'GITHUB_PAT',
    description: 'GitHub personal access token, classic',
    regex: /\bghp_[A-Za-z0-9]{36}\b/g,
  },
  {
    type: 'GITHUB_PAT_FINE',
    description: 'GitHub fine-grained personal access token (≥80 char body)',
    regex: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/g,
  },
  {
    type: 'GITHUB_OAUTH',
    description: 'GitHub OAuth user access token',
    regex: /\bgho_[A-Za-z0-9]{36}\b/g,
  },
  {
    type: 'GITHUB_INSTALL',
    description: 'GitHub App server-to-server installation token',
    regex: /\bghs_[A-Za-z0-9]{36}\b/g,
  },
  {
    type: 'GITHUB_USER_TO_SERVER',
    description: 'GitHub App user-to-server token',
    regex: /\bghu_[A-Za-z0-9]{36}\b/g,
  },
  {
    type: 'GITHUB_REFRESH',
    description: 'GitHub App refresh token',
    regex: /\bghr_[A-Za-z0-9]{36}\b/g,
  },

  // --- Stripe ---
  {
    type: 'STRIPE_LIVE',
    description: 'Stripe live secret key',
    regex: /\bsk_live_[A-Za-z0-9]{24,}\b/g,
  },
  {
    type: 'STRIPE_RESTRICTED',
    description: 'Stripe restricted key (live or test)',
    regex: /\brk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
  },

  // --- Anthropic / OpenAI (high-confidence, prefix-locked formats only) ---
  {
    type: 'ANTHROPIC_KEY',
    description: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    type: 'OPENAI_PROJECT_KEY',
    description: 'OpenAI project-scoped key (sk-proj-*) — new format only',
    regex: /\bsk-proj-[A-Za-z0-9_-]{32,}\b/g,
  },

  // --- Google ---
  {
    type: 'GOOGLE_API_KEY',
    description: 'Google API key (AIza prefix, 39 chars total)',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },

  // --- Slack ---
  {
    type: 'SLACK_TOKEN',
    description: 'Slack token (xoxa/xoxb/xoxp/xoxr/xoxs)',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },

  // --- Private keys (PEM blocks) ---
  {
    type: 'PRIVATE_KEY_PEM',
    description: 'PEM-formatted private key header (any algorithm)',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
];

/**
 * Replace every credential-pattern match in `text` with
 * `[REDACTED:<TYPE>]`. Idempotent — already-redacted strings pass
 * through unchanged.
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const { type, regex } of CREDENTIAL_PATTERNS) {
    // Each regex carries its own `g` flag and is created once at module
    // load, so resetting `lastIndex` is unnecessary — `String.replace`
    // does not use it. We reuse the same regex instance across calls
    // because the engine compiles it once.
    out = out.replace(regex, `[REDACTED:${type}]`);
  }
  return out;
}

/**
 * Diagnostic helper — returns a count per pattern type so the chunker
 * can log if a chunk had any hits. Used by the `chunkFile` integration
 * for ops visibility ("ingested repo X with N credentials redacted").
 */
export function countCredentialMatches(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { type, regex } of CREDENTIAL_PATTERNS) {
    const matches = text.match(regex);
    if (matches && matches.length > 0) counts[type] = matches.length;
  }
  return counts;
}
