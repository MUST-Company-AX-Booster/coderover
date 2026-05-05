import { LLMResponseValidatorService } from './llm-response-validator.service';

describe('LLMResponseValidatorService', () => {
  let svc: LLMResponseValidatorService;

  beforeEach(() => {
    svc = new LLMResponseValidatorService();
  });

  describe('validate — clean responses', () => {
    it('returns the response unchanged when nothing matches', () => {
      const input = 'Here is a normal explanation of how X works.';
      const res = svc.validate(input);
      expect(res.sanitized).toBe(input);
      expect(res.redactions).toEqual({});
      expect(res.truncated).toBe(false);
      expect(res.originalLength).toBe(input.length);
    });

    it('handles empty string', () => {
      const res = svc.validate('');
      expect(res.sanitized).toBe('');
      expect(res.redactions).toEqual({});
      expect(res.truncated).toBe(false);
      expect(res.originalLength).toBe(0);
    });

    it('coerces non-string defensively (null/undefined)', () => {
      // Type-bypass: production callers pass strings, but a stream-handling
      // bug could leak null through — should not throw.
      const res = svc.validate(null as unknown as string);
      expect(res.sanitized).toBe('');
      expect(res.originalLength).toBe(0);
    });
  });

  describe('validate — credential redaction', () => {
    it('redacts a leaked AWS access key from a hallucinated answer', () => {
      const response = 'Here is the access key from the codebase: AKIAIOSFODNN7EXAMPLE.';
      const res = svc.validate(response);
      expect(res.sanitized).toBe(
        'Here is the access key from the codebase: [REDACTED:AWS_ACCESS_KEY].',
      );
      expect(res.redactions).toEqual({ AWS_ACCESS_KEY: 1 });
    });

    it('redacts multiple distinct credential types in a single response', () => {
      const response =
        'AWS: AKIAIOSFODNN7EXAMPLE, GitHub: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const res = svc.validate(response);
      expect(res.sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(res.sanitized).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(res.redactions.AWS_ACCESS_KEY).toBe(1);
      expect(res.redactions.GITHUB_PAT).toBe(1);
    });
  });

  describe('validate — length truncation', () => {
    it('truncates responses longer than maxLength and respects the cap STRICTLY', () => {
      // Final string (slice + marker) must not exceed maxLength —
      // important when a downstream renderer has hard caps.
      const longResponse = 'a'.repeat(200);
      const res = svc.validate(longResponse, { maxLength: 100 });
      expect(res.truncated).toBe(true);
      expect(res.originalLength).toBe(200);
      expect(res.sanitized.length).toBeLessThanOrEqual(100);
      expect(res.sanitized).toContain('truncated by LLM guard');
    });

    it('handles tiny maxLength gracefully (smaller than the marker itself)', () => {
      // sliceTo = max(0, 5 - 30) = 0 → output is just the marker, but
      // even the marker alone is longer than maxLength here. We still
      // emit the marker so the caller knows truncation happened, but
      // we never go negative or throw.
      const res = svc.validate('a'.repeat(50), { maxLength: 5 });
      expect(res.truncated).toBe(true);
      expect(res.sanitized).toContain('truncated by LLM guard');
    });

    it('does not truncate responses at or below maxLength', () => {
      const response = 'a'.repeat(100);
      const res = svc.validate(response, { maxLength: 100 });
      expect(res.truncated).toBe(false);
      expect(res.sanitized).toBe(response);
    });

    it('uses a generous default maxLength when omitted', () => {
      // Default is 100KB; a 1KB payload should pass through.
      const response = 'a'.repeat(1024);
      const res = svc.validate(response);
      expect(res.truncated).toBe(false);
      expect(res.sanitized).toBe(response);
    });
  });

  describe('validate — combined truncation + redaction', () => {
    it('truncates first, then redacts (saves regex work on discarded bytes)', () => {
      // Build a response where the credential is in the BODY before the
      // truncation point; truncation removes some other tail bytes.
      const credential = 'AKIAIOSFODNN7EXAMPLE';
      const head = `${credential} ` + 'b'.repeat(50);
      const tail = 'c'.repeat(200);
      const res = svc.validate(head + tail, { maxLength: head.length });
      expect(res.truncated).toBe(true);
      expect(res.redactions).toEqual({ AWS_ACCESS_KEY: 1 });
      expect(res.sanitized).not.toContain(credential);
      expect(res.sanitized).toContain('[REDACTED:AWS_ACCESS_KEY]');
    });
  });
});
