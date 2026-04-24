import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';
import { FileWatcherService } from '../watcher/file-watcher.service';

describe('HealthService', () => {
  let service: HealthService;

  const mockDataSource = {
    query: jest.fn(),
  };

  const mockQueue = {
    name: 'ingest',
    getJobCounts: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const values: Record<string, string> = {
        FILE_WATCH_ENABLED: 'true',
        LLM_PROVIDER: 'local',
      };
      return values[key] ?? defaultValue;
    }),
  };

  const mockWatcher = {
    getActiveSessions: jest.fn().mockReturnValue([{ repoId: 'r1', localPath: '/tmp/repo', framework: 'nestjs' }]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getQueueToken('ingest'), useValue: mockQueue },
        { provide: ConfigService, useValue: mockConfig },
        { provide: FileWatcherService, useValue: mockWatcher },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('returns ok when database is reachable', async () => {
    mockDataSource.query
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ total_chunks: 10, embedded_chunks: 8 }]);
    mockQueue.getJobCounts.mockResolvedValue({
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 0,
      delayed: 1,
      paused: 0,
    });

    const result = await service.getHealth();

    expect(result.status).toBe('ok');
    expect(result.components.database.status).toBe('up');
    expect(result.components.queue.depth).toBe(4);
    expect(result.components.watcher.sessions).toBe(1);
    expect(result.metrics.embeddingCoverage.coveragePercent).toBe(80);
    expect(result.components.llm.status).toBe('down');
  });

  it('returns degraded when database check fails', async () => {
    mockDataSource.query
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('coverage query failed'));
    mockQueue.getJobCounts.mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    });

    const result = await service.getHealth();

    expect(result.status).toBe('degraded');
    expect(result.components.database.status).toBe('down');
    expect(result.metrics.embeddingCoverage.coveragePercent).toBe(0);
  });
});
