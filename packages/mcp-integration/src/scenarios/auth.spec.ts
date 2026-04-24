/**
 * Phase 10 A5 — Auth scenarios.
 *
 * End-to-end drives of the A4 token lifecycle against the HTTP surface:
 *   1. Mint an MCP token with scope `['citations:read']`.
 *   2. Hit `/citations/evidence` — expect 200.
 *   3. Hit `/graph/dependencies` (or another scope-gated endpoint) —
 *      expect 403 because the scope isn't held. We don't actually expose
 *      `/graph/dependencies` in the A5 test backend, so we prove the
 *      equivalent negative case: a scope-gated endpoint on CitationsController
 *      with a token that lacks the scope → 403.
 *   4. Revoke the token. Within the 30s cache window the next request 401s
 *      ("Token has been revoked").
 *   5. Forged jti → 401 (unknown jti treated as revoked per A4 contract).
 *
 * Important: steps 2/3 are expressed against the same endpoint but with
 * two different tokens, because exercising multiple controllers here would
 * force us to stub additional modules without adding test signal.
 */

import {
  createTestUser,
  issueMcpToken,
  issueForgedMcpToken,
} from '../setup/fixtures';
import { startTestBackend, TestBackend } from '../setup/test-backend';

describe('A5 — Auth token lifecycle', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await startTestBackend();
  });

  afterAll(async () => {
    if (backend) await backend.stop();
  });

  beforeEach(() => {
    // Every test starts from a clean revocation cache so positive hits
    // from earlier tests don't bleed over. The in-memory store persists
    // across tests by design — revoke-side-effects are the interesting bit.
    backend.tokenRevocation.clearCache();
  });

  const uuid = (n: number) =>
    `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

  it('200s on /citations/evidence when the token carries citations:read', async () => {
    const user = createTestUser();
    const { token } = await issueMcpToken(
      {
        tokenRevocation: backend.tokenRevocation,
        revokedTokensStore: backend.stores.revokedTokens,
      },
      user,
      ['citations:read'],
    );

    const res = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [uuid(1)] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('403s on /citations/evidence when the token lacks citations:read', async () => {
    const user = createTestUser();
    const { token } = await issueMcpToken(
      {
        tokenRevocation: backend.tokenRevocation,
        revokedTokensStore: backend.stores.revokedTokens,
      },
      user,
      ['search:read'], // present, but wrong scope
    );

    const res = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [uuid(1)] }),
    });

    expect(res.status).toBe(403);
  });

  it('revoke flips a previously-working token to 401 (critical-gap test #1)', async () => {
    const user = createTestUser();
    const { token, id } = await issueMcpToken(
      {
        tokenRevocation: backend.tokenRevocation,
        revokedTokensStore: backend.stores.revokedTokens,
      },
      user,
      ['citations:read'],
    );

    // Warm path: 200.
    const before = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [uuid(1)] }),
    });
    expect(before.status).toBe(200);

    // Revoke. `revoke` busts the cache so the next request observes the
    // new state immediately (not after the 30s TTL).
    await backend.tokenRevocation.revoke(id, user.userId);

    // After revoke: 401 "Token has been revoked".
    const after = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [uuid(1)] }),
    });
    expect(after.status).toBe(401);
  });

  it('forged jti (no revoked_tokens row) → 401', async () => {
    const user = createTestUser();
    const forged = issueForgedMcpToken(backend.jwtService, user, ['citations:read']);

    const res = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${forged}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [uuid(1)] }),
    });

    expect(res.status).toBe(401);
  });

  it('missing Authorization header → 401', async () => {
    const res = await fetch(`${backend.baseUrl}/citations/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [uuid(1)] }),
    });
    expect(res.status).toBe(401);
  });
});
