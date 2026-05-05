import { Repository } from 'typeorm';
import { LLMAuditLog } from '../entities/llm-audit-log.entity';
import { LLMAuditService, sha256 } from './llm-audit.service';

/**
 * Tests for the per-call audit recorder. Covers:
 *   - Hashing (we never persist raw prompt/response — only sha256)
 *   - Char counts derived from the original text
 *   - Default values when optional fields are omitted
 *   - Fire-and-forget: an INSERT failure is swallowed, the caller
 *     continues. This is the core promise.
 */
describe('LLMAuditService', () => {
  function makeRepo(): {
    repo: Repository<LLMAuditLog>;
    insert: jest.Mock;
  } {
    const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'fake' }] });
    return {
      repo: { insert } as unknown as Repository<LLMAuditLog>,
      insert,
    };
  }

  it('hashes prompt + response with sha256, never stores raw text', async () => {
    const { repo, insert } = makeRepo();
    const svc = new LLMAuditService(repo);
    await svc.record({
      callSite: 'copilot.chat',
      provider: 'openai',
      model: 'gpt-4o',
      promptText: 'Summarize the auth flow',
      responseText: 'The auth flow uses JWT tokens.',
    });

    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.promptHash).toBe(sha256('Summarize the auth flow'));
    expect(row.responseHash).toBe(sha256('The auth flow uses JWT tokens.'));
    // Raw text MUST NOT appear anywhere in the inserted row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('Summarize the auth flow');
    expect(serialized).not.toContain('The auth flow uses JWT tokens');
  });

  it('records prompt + response char counts', async () => {
    const { repo, insert } = makeRepo();
    const svc = new LLMAuditService(repo);
    await svc.record({
      callSite: 'copilot.chat',
      provider: 'openai',
      model: 'gpt-4o',
      promptText: 'a'.repeat(123),
      responseText: 'b'.repeat(456),
    });
    const row = insert.mock.calls[0][0];
    expect(row.promptChars).toBe(123);
    expect(row.responseChars).toBe(456);
  });

  it('handles a kill-switch-blocked call (no response, killSwitchBlocked=true)', async () => {
    const { repo, insert } = makeRepo();
    const svc = new LLMAuditService(repo);
    await svc.record({
      callSite: 'copilot.chat',
      provider: 'openai',
      model: 'gpt-4o',
      promptText: 'anything',
      responseText: null,
      killSwitchBlocked: true,
      error: 'LLM Kill Switch Engaged',
    });
    const row = insert.mock.calls[0][0];
    expect(row.killSwitchBlocked).toBe(true);
    expect(row.responseHash).toBeNull();
    expect(row.responseChars).toBeNull();
    expect(row.error).toBe('LLM Kill Switch Engaged');
  });

  it('passes redactions tally through unchanged', async () => {
    const { repo, insert } = makeRepo();
    const svc = new LLMAuditService(repo);
    await svc.record({
      callSite: 'copilot.chat',
      provider: 'openai',
      model: 'gpt-4o',
      promptText: 'p',
      responseText: 'r',
      redactions: { AWS_ACCESS_KEY: 2, GITHUB_PAT: 1 },
    });
    expect(insert.mock.calls[0][0].redactions).toEqual({
      AWS_ACCESS_KEY: 2,
      GITHUB_PAT: 1,
    });
  });

  it('defaults optional fields when omitted', async () => {
    const { repo, insert } = makeRepo();
    const svc = new LLMAuditService(repo);
    await svc.record({
      callSite: 'copilot.chat',
      provider: 'openai',
      model: 'gpt-4o',
      promptText: 'p',
    });
    const row = insert.mock.calls[0][0];
    expect(row.orgId).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.responseHash).toBeNull();
    expect(row.responseChars).toBeNull();
    expect(row.promptTokens).toBeNull();
    expect(row.completionTokens).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.latencyMs).toBeNull();
    expect(row.killSwitchBlocked).toBe(false);
    expect(row.redactions).toEqual({});
    expect(row.error).toBeNull();
  });

  it('FIRE-AND-FORGET — swallows insert failures, never throws', async () => {
    const insert = jest.fn().mockRejectedValue(new Error('connection refused'));
    const repo = { insert } as unknown as Repository<LLMAuditLog>;
    const svc = new LLMAuditService(repo);

    // The contract: `record()` resolves. If it threw, every LLM call
    // site would have to wrap audit in try/catch — defeats the point.
    await expect(
      svc.record({
        callSite: 'copilot.chat',
        provider: 'openai',
        model: 'gpt-4o',
        promptText: 'p',
      }),
    ).resolves.toBeUndefined();
  });

  it('passes through orgId + userId + token counts when provided', async () => {
    const { repo, insert } = makeRepo();
    const svc = new LLMAuditService(repo);
    await svc.record({
      orgId: 'org-1',
      userId: 'user-1',
      callSite: 'copilot.chat',
      provider: 'openai',
      model: 'gpt-4o',
      promptText: 'p',
      responseText: 'r',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      latencyMs: 1234,
    });
    const row = insert.mock.calls[0][0];
    expect(row.orgId).toBe('org-1');
    expect(row.userId).toBe('user-1');
    expect(row.promptTokens).toBe(100);
    expect(row.completionTokens).toBe(50);
    expect(row.totalTokens).toBe(150);
    expect(row.latencyMs).toBe(1234);
  });
});

describe('sha256 helper', () => {
  it('produces deterministic 64-char hex for the same input', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
    expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different output for different input', () => {
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  it('handles UTF-8 multi-byte input', () => {
    const out = sha256('测试-🔐-müller');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});
