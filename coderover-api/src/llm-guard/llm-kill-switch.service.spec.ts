import { LLMKillSwitchError, LLMKillSwitchService } from './llm-kill-switch.service';

describe('LLMKillSwitchService', () => {
  const ENV = 'LLM_KILL_SWITCH';
  const ORIG = process.env[ENV];

  beforeEach(() => {
    delete process.env[ENV];
  });

  afterAll(() => {
    if (ORIG === undefined) delete process.env[ENV];
    else process.env[ENV] = ORIG;
  });

  describe('isEngaged', () => {
    it('returns false when env var is unset', () => {
      const svc = new LLMKillSwitchService();
      expect(svc.isEngaged()).toBe(false);
    });

    it('returns false when env var is empty string', () => {
      process.env[ENV] = '';
      const svc = new LLMKillSwitchService();
      expect(svc.isEngaged()).toBe(false);
    });

    it.each([
      ['1'],
      ['true'],
      ['TRUE'],
      ['yes'],
      ['YES'],
      ['on'],
      ['enabled'],
      ['  true  '], // whitespace tolerated
    ])('returns true for truthy value %s', value => {
      process.env[ENV] = value;
      const svc = new LLMKillSwitchService();
      expect(svc.isEngaged()).toBe(true);
    });

    it.each([
      ['0'],
      ['false'],
      ['no'],
      ['off'],
      ['disabled'],
      ['random-string'],
      ['2'], // not in the truthy set on purpose — operator must use clear values
    ])('returns false for non-truthy value %s', value => {
      process.env[ENV] = value;
      const svc = new LLMKillSwitchService();
      expect(svc.isEngaged()).toBe(false);
    });

    it('re-reads process.env on every call (no caching)', () => {
      const svc = new LLMKillSwitchService();
      expect(svc.isEngaged()).toBe(false);
      process.env[ENV] = '1';
      expect(svc.isEngaged()).toBe(true);
      delete process.env[ENV];
      expect(svc.isEngaged()).toBe(false);
    });
  });

  describe('assertNotKilled', () => {
    it('returns silently when switch is off', () => {
      const svc = new LLMKillSwitchService();
      expect(() => svc.assertNotKilled()).not.toThrow();
    });

    it('throws LLMKillSwitchError when switch is on', () => {
      process.env[ENV] = '1';
      const svc = new LLMKillSwitchService();
      expect(() => svc.assertNotKilled()).toThrow(LLMKillSwitchError);
    });

    it('the thrown error carries 503 status and an actionable message', () => {
      process.env[ENV] = 'true';
      const svc = new LLMKillSwitchService();
      try {
        svc.assertNotKilled();
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMKillSwitchError);
        const response = (err as LLMKillSwitchError).getResponse() as {
          statusCode: number;
          error: string;
          message: string;
        };
        expect(response.statusCode).toBe(503);
        expect(response.error).toMatch(/Kill Switch/);
        expect(response.message).toMatch(/disabled by an operator/);
      }
    });
  });
});
