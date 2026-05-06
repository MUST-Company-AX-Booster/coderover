import { ConfigService } from '@nestjs/config';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { LLMAuditLog } from '../entities/llm-audit-log.entity';
import { LLMAnomalyAlertsService } from './llm-anomaly-alerts.service';

/**
 * Tests for the periodic anomaly sweep. We stub the TypeORM repo's
 * `createQueryBuilder` chain — the service is a pure SQL aggregator with
 * threshold logic on top, so a mocked QueryBuilder gives us full control
 * over what each of the three signal queries returns.
 *
 * Each signal can be exercised independently: the sweep runs all three
 * queries every time, and the assertions filter the resulting alert
 * array.
 */
describe('LLMAnomalyAlertsService', () => {
  /**
   * Build a fluent QueryBuilder stub. `getRawMany` returns the per-test
   * fixture; `getCount` returns a separate count for the kill-switch path.
   */
  function makeQB(rows: unknown[], count = 0): SelectQueryBuilder<LLMAuditLog> {
    const qb: Partial<SelectQueryBuilder<LLMAuditLog>> = {
      select: jest.fn().mockReturnThis() as never,
      addSelect: jest.fn().mockReturnThis() as never,
      where: jest.fn().mockReturnThis() as never,
      andWhere: jest.fn().mockReturnThis() as never,
      groupBy: jest.fn().mockReturnThis() as never,
      having: jest.fn().mockReturnThis() as never,
      getRawMany: jest.fn(async () => rows) as never,
      getCount: jest.fn(async () => count) as never,
    };
    return qb as SelectQueryBuilder<LLMAuditLog>;
  }

  /**
   * The service issues 3 createQueryBuilder calls per sweep (one per
   * signal). Order:
   *   1. checkTokenRatePerOrg     → getRawMany
   *   2. checkSustainedRedactions → getRawMany
   *   3. checkKillSwitchVolume    → getCount
   */
  function makeRepo(opts: {
    tokenRows?: unknown[];
    redactionRows?: unknown[];
    killSwitchCount?: number;
  }): Repository<LLMAuditLog> {
    let i = 0;
    const qbs = [
      makeQB(opts.tokenRows ?? []),
      makeQB(opts.redactionRows ?? []),
      makeQB([], opts.killSwitchCount ?? 0),
    ];
    return {
      createQueryBuilder: jest.fn(() => qbs[i++ % qbs.length]),
    } as unknown as Repository<LLMAuditLog>;
  }

  function makeConfig(overrides: Record<string, string> = {}): ConfigService {
    const get = jest.fn((key: string) => overrides[key]);
    return { get } as unknown as ConfigService;
  }

  describe('runSweep — token-rate spike per org', () => {
    it('emits an alert per over-threshold org', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          tokenRows: [
            { orgId: 'org-a', total: 250_000 },
            { orgId: 'org-b', total: 110_000 },
          ],
        }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      const tokenAlerts = alerts.filter(a => a.signal === 'llm_anomaly.token_rate_spike');
      expect(tokenAlerts).toHaveLength(2);
      expect(tokenAlerts[0].scope).toEqual({ org_id: 'org-a' });
      expect(tokenAlerts[0].metric).toBe(250_000);
      expect(tokenAlerts[1].scope).toEqual({ org_id: 'org-b' });
    });

    it('emits no alert when no org breaches the threshold', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({ tokenRows: [] }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      expect(alerts.filter(a => a.signal === 'llm_anomaly.token_rate_spike')).toHaveLength(
        0,
      );
    });

    it('respects ANOMALY_TOKEN_RATE_PER_ORG override = 0 (signal disabled)', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          tokenRows: [{ orgId: 'org-a', total: 999_999_999 }],
        }),
        makeConfig({ ANOMALY_TOKEN_RATE_PER_ORG: '0' }),
      );
      const alerts = await svc.runSweep();
      // Even with massive usage, override-to-zero disables the signal.
      expect(alerts.filter(a => a.signal === 'llm_anomaly.token_rate_spike')).toHaveLength(
        0,
      );
    });

    it('coerces bigint-as-string from the pg driver into a number safely', async () => {
      // Postgres SUM/COUNT return bigint; node-postgres surfaces those
      // as strings. The query in production therefore yields
      // `total: "5000000000"`, NOT `total: 5_000_000_000`. The metric
      // field on the alert must still be a real number, well past
      // int4 max (2^31 - 1 = 2_147_483_647) to verify we removed the
      // ::int cast cleanly.
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          tokenRows: [{ orgId: 'org-a', total: '5000000000' }],
        }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      const tokenAlerts = alerts.filter(a => a.signal === 'llm_anomaly.token_rate_spike');
      expect(tokenAlerts).toHaveLength(1);
      expect(tokenAlerts[0].metric).toBe(5_000_000_000);
      expect(typeof tokenAlerts[0].metric).toBe('number');
    });
  });

  describe('runSweep — sustained redactions per call_site', () => {
    it('emits an alert per over-threshold call_site', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          redactionRows: [
            { callSite: 'copilot.chat', cnt: 22 },
            { callSite: 'embedder.batch', cnt: 11 },
          ],
        }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      const redactAlerts = alerts.filter(
        a => a.signal === 'llm_anomaly.sustained_redactions',
      );
      expect(redactAlerts).toHaveLength(2);
      expect(redactAlerts[0].scope).toEqual({ call_site: 'copilot.chat' });
      expect(redactAlerts[0].metric).toBe(22);
    });

    it('coerces bigint-as-string COUNT result into a number', async () => {
      // Same overflow-safety reasoning as the SUM test above: pg's
      // COUNT(*) returns bigint, surfaced as a string. Number()
      // handles up to 2^53 safely.
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          redactionRows: [{ callSite: 'copilot.chat', cnt: '15' }],
        }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      const redactAlerts = alerts.filter(
        a => a.signal === 'llm_anomaly.sustained_redactions',
      );
      expect(redactAlerts[0].metric).toBe(15);
      expect(typeof redactAlerts[0].metric).toBe('number');
    });
  });

  describe('runSweep — kill-switch volume', () => {
    it('emits a single global alert when count exceeds threshold', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({ killSwitchCount: 75 }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      const ksAlerts = alerts.filter(a => a.signal === 'llm_anomaly.kill_switch_volume');
      expect(ksAlerts).toHaveLength(1);
      expect(ksAlerts[0].scope).toEqual({});
      expect(ksAlerts[0].metric).toBe(75);
    });

    it('emits no alert when count is below threshold', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({ killSwitchCount: 10 }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      expect(alerts.filter(a => a.signal === 'llm_anomaly.kill_switch_volume')).toHaveLength(
        0,
      );
    });
  });

  describe('alert payload shape', () => {
    it('every alert carries threshold + windowMinutes + observedAt', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          tokenRows: [{ orgId: 'org-a', total: 200_000 }],
          redactionRows: [{ callSite: 'copilot.chat', cnt: 50 }],
          killSwitchCount: 100,
        }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      expect(alerts.length).toBe(3);
      for (const a of alerts) {
        expect(typeof a.threshold).toBe('number');
        expect(typeof a.windowMinutes).toBe('number');
        expect(a.windowMinutes).toBe(60); // default
        expect(typeof a.observedAt).toBe('string');
        // ISO 8601 shape
        expect(a.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });
  });

  describe('configuration', () => {
    it('honors ANOMALY_WINDOW_MINUTES override', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          tokenRows: [{ orgId: 'org-a', total: 200_000 }],
        }),
        makeConfig({ ANOMALY_WINDOW_MINUTES: '15' }),
      );
      const alerts = await svc.runSweep();
      expect(alerts[0].windowMinutes).toBe(15);
    });

    it('falls back to default when env value is non-numeric', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          tokenRows: [{ orgId: 'org-a', total: 200_000 }],
        }),
        makeConfig({ ANOMALY_WINDOW_MINUTES: 'not-a-number' }),
      );
      const alerts = await svc.runSweep();
      expect(alerts[0].windowMinutes).toBe(60); // default
    });
  });

  describe('module lifecycle', () => {
    it('onModuleInit schedules an interval; onModuleDestroy clears it', () => {
      const svc = new LLMAnomalyAlertsService(makeRepo({}), makeConfig());
      svc.onModuleInit();
      expect((svc as unknown as { timer: NodeJS.Timeout | null }).timer).not.toBeNull();
      svc.onModuleDestroy();
      expect((svc as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
    });

    it('onModuleInit skips scheduling when ANOMALY_CHECK_INTERVAL_MS=0', () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({}),
        makeConfig({ ANOMALY_CHECK_INTERVAL_MS: '0' }),
      );
      svc.onModuleInit();
      expect((svc as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
    });
  });

  describe('Phase 4D — cooldown', () => {
    /**
     * Build a repo that returns the same single token-rate breach on
     * every sweep. Used to drive multi-sweep cooldown scenarios. Each
     * sweep issues 3 createQueryBuilder calls (one per signal); we
     * make the first of every triple return the breach.
     */
    function makeStableTokenRepo(): Repository<LLMAuditLog> {
      let i = 0;
      return {
        createQueryBuilder: jest.fn(() => {
          const tripletPosition = i++ % 3;
          if (tripletPosition === 0) {
            return makeQB([{ orgId: 'org-a', total: 200_000 }]);
          }
          return makeQB([], 0);
        }),
      } as unknown as Repository<LLMAuditLog>;
    }

    it('suppresses a repeat alert for the same (signal, scope) within the cooldown window', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeStableTokenRepo(),
        makeConfig({ ANOMALY_COOLDOWN_MINUTES: '30' }),
      );
      const first = await svc.runSweep();
      const second = await svc.runSweep();
      expect(first).toHaveLength(1);
      expect(first[0].signal).toBe('llm_anomaly.token_rate_spike');
      expect(second).toHaveLength(0);
    });

    it('re-fires the same alert once the cooldown elapses', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeStableTokenRepo(),
        makeConfig({ ANOMALY_COOLDOWN_MINUTES: '1' }),
      );
      const first = await svc.runSweep();
      expect(first).toHaveLength(1);

      // Reach into the private cooldownState and rewind by 2 minutes.
      // Equivalent to "wait 2 minutes" but instant. Adjusting Date.now()
      // globally would be more elegant but Jest fake timers don't
      // compose well with the rest of the sweep's async path.
      const state = (svc as unknown as { cooldownState: Map<string, number> }).cooldownState;
      for (const [k, v] of state.entries()) state.set(k, v - 2 * 60_000);

      const second = await svc.runSweep();
      expect(second).toHaveLength(1);
    });

    it('treats different scopes as separate cooldown keys', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeRepo({
          tokenRows: [
            { orgId: 'org-a', total: 250_000 },
            { orgId: 'org-b', total: 110_000 },
          ],
        }),
        makeConfig({ ANOMALY_COOLDOWN_MINUTES: '30' }),
      );
      const alerts = await svc.runSweep();
      expect(alerts).toHaveLength(2);
      expect(alerts.map((a) => a.scope)).toEqual([
        { org_id: 'org-a' },
        { org_id: 'org-b' },
      ]);
    });

    it('disables cooldown entirely when ANOMALY_COOLDOWN_MINUTES=0', async () => {
      const svc = new LLMAnomalyAlertsService(
        makeStableTokenRepo(),
        makeConfig({ ANOMALY_COOLDOWN_MINUTES: '0' }),
      );
      const first = await svc.runSweep();
      const second = await svc.runSweep();
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
    });
  });

  describe('Phase 4D — webhook sink', () => {
    afterEach(() => {
      delete (globalThis as { fetch?: unknown }).fetch;
    });

    it('does NOT call fetch when ANOMALY_WEBHOOK_URL is unset (logs-only mode)', async () => {
      const fetchSpy = jest.fn();
      (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

      const svc = new LLMAnomalyAlertsService(
        makeRepo({ tokenRows: [{ orgId: 'org-a', total: 200_000 }] }),
        makeConfig(),
      );
      const alerts = await svc.runSweep();
      expect(alerts).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs alert as JSON when ANOMALY_WEBHOOK_URL is set', async () => {
      const fetchSpy = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
      (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

      const svc = new LLMAnomalyAlertsService(
        makeRepo({ tokenRows: [{ orgId: 'org-a', total: 200_000 }] }),
        makeConfig({ ANOMALY_WEBHOOK_URL: 'https://example.test/hook' }),
      );
      await svc.runSweep();
      // fire-and-forget — wait one tick so the awaited fetch runs.
      await new Promise((r) => setImmediate(r));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://example.test/hook');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body as string);
      expect(body.signal).toBe('llm_anomaly.token_rate_spike');
      expect(body.scope).toEqual({ org_id: 'org-a' });
      expect(body.metric).toBe(200_000);
    });

    it('attaches Authorization header when ANOMALY_WEBHOOK_AUTH_HEADER is set', async () => {
      const fetchSpy = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
      (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

      const svc = new LLMAnomalyAlertsService(
        makeRepo({ tokenRows: [{ orgId: 'org-a', total: 200_000 }] }),
        makeConfig({
          ANOMALY_WEBHOOK_URL: 'https://example.test/hook',
          ANOMALY_WEBHOOK_AUTH_HEADER: 'Bearer secret-token',
        }),
      );
      await svc.runSweep();
      await new Promise((r) => setImmediate(r));

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer secret-token');
    });

    it('warn-logs and swallows webhook failures (sweep continues)', async () => {
      const fetchSpy = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

      const svc = new LLMAnomalyAlertsService(
        makeRepo({ tokenRows: [{ orgId: 'org-a', total: 200_000 }] }),
        makeConfig({ ANOMALY_WEBHOOK_URL: 'https://example.test/hook' }),
      );
      const warnSpy = jest
        .spyOn((svc as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);

      const alerts = await svc.runSweep();
      expect(alerts).toHaveLength(1);

      await new Promise((r) => setImmediate(r));
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('Anomaly webhook POST failed'))).toBe(true);
      expect(messages.some((m) => m.includes('connect ECONNREFUSED'))).toBe(true);
    });

    it('warn-logs non-2xx HTTP responses', async () => {
      const fetchSpy = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

      const svc = new LLMAnomalyAlertsService(
        makeRepo({ tokenRows: [{ orgId: 'org-a', total: 200_000 }] }),
        makeConfig({ ANOMALY_WEBHOOK_URL: 'https://example.test/hook' }),
      );
      const warnSpy = jest
        .spyOn((svc as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);

      await svc.runSweep();
      await new Promise((r) => setImmediate(r));

      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('returned 500'))).toBe(true);
    });
  });
});
