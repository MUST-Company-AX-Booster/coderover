import { describe, it, expect } from 'vitest';
import { deriveFleet, type HealthResponse } from '../useFleetStatus';

const base: HealthResponse = {
  status: 'ok',
  timestamp: '2026-04-21T06:00:00.000Z',
  components: {
    database: { status: 'up', latencyMs: 42 },
    queue: { status: 'up', name: 'ingest', depth: 0 },
    watcher: { status: 'up', enabled: true, sessions: 0 },
    llm: { status: 'up', provider: 'openrouter', latencyMs: 800 },
  },
  metrics: {
    embeddingCoverage: { totalChunks: 1295, embeddedChunks: 1295, coveragePercent: 100 },
  },
};

describe('deriveFleet', () => {
  it('returns 5 rovers in fixed order', () => {
    const fleet = deriveFleet(base);
    expect(fleet).toHaveLength(5);
    expect(fleet.map((r) => r.name)).toEqual(['Scout', 'Tinker', 'Sentinel', 'Beacon', 'Archive']);
    expect(fleet.map((r) => r.unit)).toEqual([1, 2, 3, 4, 5]);
  });

  it('marks [scout] armed when queue is up and no sessions', () => {
    const [scout] = deriveFleet(base);
    expect(scout.status).toBe('armed');
    expect(scout.note).toContain('queue depth 0');
    expect(scout.note).toContain('0 sessions');
  });

  it('marks [scout] online when watcher has active sessions', () => {
    const [scout] = deriveFleet({
      ...base,
      components: { ...base.components, watcher: { status: 'up', enabled: true, sessions: 3 } },
    });
    expect(scout.status).toBe('online');
    expect(scout.note).toContain('3 sessions');
  });

  it('marks [scout] offline when queue is down', () => {
    const [scout] = deriveFleet({
      ...base,
      components: { ...base.components, queue: { status: 'down' } },
    });
    expect(scout.status).toBe('offline');
    expect(scout.note).toBe('[scout] queue down.');
  });

  it('marks [tinker] and [sentinel] offline when LLM is down and surfaces error', () => {
    const fleet = deriveFleet({
      ...base,
      components: {
        ...base.components,
        llm: { status: 'down', provider: 'openrouter', error: '401 User not found.' },
      },
    });
    const tinker = fleet.find((r) => r.name === 'Tinker')!;
    const sentinel = fleet.find((r) => r.name === 'Sentinel')!;
    expect(tinker.status).toBe('offline');
    expect(tinker.note).toBe('[llm] 401 User not found.');
    expect(sentinel.status).toBe('offline');
    expect(sentinel.note).toBe('[llm] 401 User not found.');
  });

  it('marks [beacon] patrolling when watcher + db are healthy and enabled', () => {
    const beacon = deriveFleet(base).find((r) => r.name === 'Beacon')!;
    expect(beacon.status).toBe('patrolling');
    expect(beacon.note).toContain('watcher enabled');
    expect(beacon.note).toContain('db 42ms');
  });

  it('marks [beacon] offline when watcher is disabled', () => {
    const beacon = deriveFleet({
      ...base,
      components: { ...base.components, watcher: { status: 'up', enabled: false, sessions: 0 } },
    }).find((r) => r.name === 'Beacon')!;
    expect(beacon.status).toBe('offline');
  });

  it('marks [archive] online at 100% embedding coverage', () => {
    const archive = deriveFleet(base).find((r) => r.name === 'Archive')!;
    expect(archive.status).toBe('online');
    expect(archive.note).toBe('1,295 / 1,295 chunks indexed.');
  });

  it('marks [archive] patrolling at partial coverage', () => {
    const archive = deriveFleet({
      ...base,
      metrics: { embeddingCoverage: { totalChunks: 100, embeddedChunks: 80 } },
    }).find((r) => r.name === 'Archive')!;
    expect(archive.status).toBe('patrolling');
    expect(archive.note).toBe('80 / 100 chunks indexed.');
  });

  it('marks [archive] armed when no chunks indexed', () => {
    const archive = deriveFleet({
      ...base,
      metrics: { embeddingCoverage: { totalChunks: 0, embeddedChunks: 0 } },
    }).find((r) => r.name === 'Archive')!;
    expect(archive.status).toBe('armed');
    expect(archive.note).toBe('[archive] no chunks indexed yet.');
  });
});
