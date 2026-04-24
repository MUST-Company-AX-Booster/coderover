import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
    embeddings: { create: jest.fn() },
  })),
}));

/**
 * Phase 10 B2 — isolated test for the `writePrReviewFindings` hook on
 * `PrReviewService`. We reach the private method via `any` so this spec
 * doesn't have to wire the full PR-review DI graph (GitHub, search,
 * events, GitHub App, token resolver, embeddings, …). The behaviour
 * we want to pin is:
 *
 *   1. Finding whose key matches the deterministic set → EXTRACTED / 1.0.
 *   2. AI-only finding without a self-score → AMBIGUOUS / null.
 *   3. AI-only finding with a self-score → stays AMBIGUOUS today (the
 *      model doesn't return one — when it does, the tagger flips it to
 *      INFERRED automatically).
 *   4. Severity mapping: critical/warning/suggestion/info → critical/high/medium/low.
 */
describe('PrReviewService.writePrReviewFindings (Phase 10 B2)', () => {
  const findingRepo = { insert: jest.fn().mockResolvedValue(undefined) };
  const tagger = new ConfidenceTaggerService();

  // Minimal shim standing in for PrReviewService — only the fields the
  // private method reads. `confidenceTagger` + `findingRepository` are what
  // the production service injects; `chatModel` is read into evidence_ref.
  //
  // We load the real PrReviewService class so its method body is under test,
  // but manually bind `this` rather than going through NestJS DI. This
  // avoids dragging in OpenAI + GitHub + search constructors.
  //
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrReviewService } = require('./pr-review.service');

  beforeEach(() => {
    findingRepo.insert.mockClear();
  });

  async function invoke(
    items: any[],
    deterministicKeys: Set<string>,
    overrides: Record<string, unknown> = {},
  ) {
    const ctx: any = {
      logger: { warn: jest.fn(), debug: jest.fn() },
      findingRepository: findingRepo,
      confidenceTagger: tagger,
      chatModel: 'gpt-4o-mini',
      ...overrides,
    };
    await PrReviewService.prototype['writePrReviewFindings'].call(
      ctx,
      'review-uuid-1',
      'org-uuid-1',
      items,
      deterministicKeys,
    );
  }

  it('tags deterministic findings as EXTRACTED with score 1.0', async () => {
    const det = {
      file: 'src/a.ts',
      line: 10,
      message: 'Hardcoded secret',
      severity: 'critical',
      category: 'security',
    };
    const keys = new Set([`${det.file}|${det.category}|${det.message}`]);

    await invoke([det], keys);

    expect(findingRepo.insert).toHaveBeenCalledTimes(1);
    const rows = findingRepo.insert.mock.calls[0][0];
    expect(rows[0]).toMatchObject({
      prReviewId: 'review-uuid-1',
      orgId: 'org-uuid-1',
      file: 'src/a.ts',
      line: 10,
      severity: 'critical',
      category: 'security',
      confidence: 'EXTRACTED',
      confidenceScore: 1.0,
      producer: 'pr-review:deterministic',
    });
  });

  it('tags AI-only findings as AMBIGUOUS today (no per-finding self-score)', async () => {
    const ai = {
      file: 'src/b.ts',
      line: 42,
      message: 'Consider caching this query',
      severity: 'suggestion',
      category: 'performance',
    };

    await invoke([ai], new Set()); // empty deterministic set

    const rows = findingRepo.insert.mock.calls[0][0];
    expect(rows[0]).toMatchObject({
      confidence: 'AMBIGUOUS',
      confidenceScore: null,
      producer: 'pr-review:ai',
      severity: 'medium', // 'suggestion' → 'medium'
    });
  });

  it('maps the four in-service severities onto the storage enum', async () => {
    const items = [
      { file: 'a', line: 1, message: 'c', severity: 'critical', category: 'security' },
      { file: 'a', line: 2, message: 'w', severity: 'warning', category: 'security' },
      { file: 'a', line: 3, message: 's', severity: 'suggestion', category: 'style' },
      { file: 'a', line: 4, message: 'i', severity: 'info', category: 'maintainability' },
    ];

    await invoke(items, new Set());

    const rows = findingRepo.insert.mock.calls[0][0];
    expect(rows.map((r: any) => r.severity)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);
  });

  it('no-ops when there are zero items', async () => {
    await invoke([], new Set());
    expect(findingRepo.insert).not.toHaveBeenCalled();
  });

  it('recognizes a previously-deterministic finding that the AI re-surfaced', async () => {
    // mergeFindings dedupes by file|category|message, so the model may
    // cite the same issue the deterministic checker found. That row must
    // still carry EXTRACTED because the rule-based producer saw it first.
    const shared = {
      file: 'src/a.ts',
      line: 1,
      message: 'Dependency changes detected',
      severity: 'suggestion',
      category: 'maintainability',
    };
    const keys = new Set([`${shared.file}|${shared.category}|${shared.message}`]);

    await invoke([shared], keys);

    const rows = findingRepo.insert.mock.calls[0][0];
    expect(rows[0].confidence).toBe('EXTRACTED');
  });
});
