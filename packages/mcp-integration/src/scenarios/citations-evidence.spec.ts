/**
 * Phase 10 A5 — B4 /citations/evidence end-to-end.
 *
 * Seeds a mixed citations + findings batch and drives the real
 * CitationsController / CitationsService through HTTP:
 *
 *   - 5 rag_citations (3 INFERRED, 2 AMBIGUOUS), 5 pr_review_findings.
 *   - Mix in a cross-org id → must surface as `kind: 'not_found'`
 *     (no existence leak).
 *   - `similar_citations` → capped at 3, never includes the source id.
 *   - `upstream_audits` → populated when a citation's evidence_ref.edge_id
 *     matches a seeded edge_producer_audit row.
 */

import {
  buildCitation,
  buildFinding,
  buildEdgeAudit,
  createTestUser,
  issueMcpToken,
} from '../setup/fixtures';
import { startTestBackend, TestBackend } from '../setup/test-backend';

describe('A5 — /citations/evidence batch end-to-end', () => {
  let backend: TestBackend;
  let token: string;
  let userOrgId: string;

  beforeAll(async () => {
    backend = await startTestBackend();
    const user = createTestUser('org-a5-primary');
    userOrgId = user.orgId;
    ({ token } = await issueMcpToken(
      {
        tokenRevocation: backend.tokenRevocation,
        revokedTokensStore: backend.stores.revokedTokens,
      },
      user,
      ['citations:read'],
    ));
  });

  afterAll(async () => {
    if (backend) await backend.stop();
  });

  async function postEvidence(ids: string[]) {
    const res = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids }),
    });
    const body = (await res.json()) as { results: any[]; message?: string };
    return { status: res.status, body };
  }

  it('returns mixed results, cross-org becomes not_found, audits attach', async () => {
    // ──── Seed phase ────────────────────────────────────────────────────
    // An edge + audit rows that multiple citations reference.
    const edgeId = 'edge-a5-1';
    backend.stores.edgeAudits.seed(
      buildEdgeAudit({
        edgeId,
        producer: 'ast:graph-sync',
        producerKind: 'EXTRACTED',
        producerConfidence: 1.0,
      }) as any,
    );

    // 3 INFERRED citations, 2 AMBIGUOUS — all in the user's org. Two point
    // at the same file so similar_citations is exercised.
    const citations = [
      buildCitation({
        orgId: userOrgId,
        filePath: 'src/payment/payment.service.ts',
        tag: 'INFERRED',
        score: 0.62,
        producer: 'llm/gpt-4o-mini',
        evidenceRef: { edge_id: edgeId },
      }),
      buildCitation({
        orgId: userOrgId,
        filePath: 'src/payment/payment.service.ts',
        tag: 'INFERRED',
        score: 0.55,
        producer: 'hybrid-search',
      }),
      buildCitation({
        orgId: userOrgId,
        filePath: 'src/payment/payment.service.ts',
        tag: 'INFERRED',
        score: 0.71,
        producer: 'hybrid-search',
      }),
      buildCitation({
        orgId: userOrgId,
        filePath: 'src/orders/orders.service.ts',
        tag: 'AMBIGUOUS',
        producer: 'hybrid-search',
      }),
      buildCitation({
        orgId: userOrgId,
        filePath: 'src/orders/orders.service.ts',
        tag: 'AMBIGUOUS',
        producer: 'hybrid-search',
      }),
    ].map((c) => backend.stores.ragCitations.seed(c as any)) as any[];

    // 5 findings, one referencing the edge.
    const findings = [
      buildFinding({
        orgId: userOrgId,
        file: 'src/payment/payment.service.ts',
        tag: 'INFERRED',
        score: 0.6,
        producer: 'pr-review:ai',
        evidenceRef: { edge_id: edgeId },
      }),
      buildFinding({
        orgId: userOrgId,
        file: 'src/auth/auth.service.ts',
        tag: 'EXTRACTED',
        score: 1.0,
        producer: 'pr-review:deterministic',
      }),
      buildFinding({
        orgId: userOrgId,
        file: 'src/auth/auth.service.ts',
        tag: 'AMBIGUOUS',
        producer: 'pr-review:ai',
      }),
      buildFinding({
        orgId: userOrgId,
        file: 'src/orders/orders.service.ts',
        tag: 'INFERRED',
        score: 0.58,
        producer: 'pr-review:ai',
      }),
      buildFinding({
        orgId: userOrgId,
        file: 'src/orders/orders.service.ts',
        tag: 'EXTRACTED',
        score: 1.0,
        producer: 'pr-review:deterministic',
      }),
    ].map((f) => backend.stores.prFindings.seed(f as any)) as any[];

    // A citation in a different org — must come back as not_found.
    const crossOrgCitation = backend.stores.ragCitations.seed(
      buildCitation({
        orgId: 'some-other-org',
        filePath: 'src/other/other.ts',
        tag: 'INFERRED',
        score: 0.9,
      }) as any,
    ) as any;

    // ──── Exercise ─────────────────────────────────────────────────────
    // Mix types + the cross-org id. Preserving order is a documented
    // contract of the endpoint.
    const inputIds = [
      citations[0].id,
      findings[0].id,
      citations[3].id,
      crossOrgCitation.id,
      findings[4].id,
    ];

    const { status, body } = await postEvidence(inputIds);
    expect(status).toBe(200);

    const byId = new Map<string, any>(body.results.map((r: any) => [r.id, r]));
    expect(body.results.map((r: any) => r.id)).toEqual(inputIds);

    // The first INFERRED citation must have upstream_audits populated
    // because its evidence_ref.edge_id matches the seeded audit row.
    const first = byId.get(citations[0].id);
    expect(first.kind).toBe('citation');
    expect(first.tag).toBe('INFERRED');
    expect(first.evidence.upstream_audits.length).toBeGreaterThanOrEqual(1);
    expect(first.evidence.upstream_audits[0]).toMatchObject({
      producer: 'ast:graph-sync',
      producer_kind: 'EXTRACTED',
      producer_confidence: 1.0,
    });

    // Finding with the same edge_id — audits should also attach.
    const findingWithEdge = byId.get(findings[0].id);
    expect(findingWithEdge.kind).toBe('finding');
    expect(findingWithEdge.evidence.upstream_audits.length).toBeGreaterThanOrEqual(1);

    // Cross-org id: kind: 'not_found', no tag, no evidence.
    const crossOrg = byId.get(crossOrgCitation.id);
    expect(crossOrg.kind).toBe('not_found');
    expect(crossOrg.tag).toBeNull();
    expect(crossOrg.evidence).toBeNull();
  });

  it('similar_citations is ≤ 3 and excludes the source id', async () => {
    const sameFileOrgId = 'org-a5-sim';
    const user = createTestUser(sameFileOrgId);
    const { token: simToken } = await issueMcpToken(
      {
        tokenRevocation: backend.tokenRevocation,
        revokedTokensStore: backend.stores.revokedTokens,
      },
      user,
      ['citations:read'],
    );

    // Seed 5 citations in the same file, same org.
    const seeded = Array.from({ length: 5 }, (_, i) =>
      backend.stores.ragCitations.seed(
        buildCitation({
          orgId: sameFileOrgId,
          filePath: 'src/wide/file.ts',
          tag: 'INFERRED',
          score: 0.9 - i * 0.05,
          producer: 'hybrid-search',
        }) as any,
      ),
    ) as any[];

    const res = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${simToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [seeded[0].id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };

    const result = body.results[0];
    expect(result.kind).toBe('citation');
    expect(result.evidence.similar_citations.length).toBeLessThanOrEqual(3);
    // Source id never included in its own similar list.
    for (const sim of result.evidence.similar_citations) {
      expect(sim.id).not.toBe(seeded[0].id);
    }
  });
});
