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
});
