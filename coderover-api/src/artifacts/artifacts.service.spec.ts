import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ArtifactsService } from './artifacts.service';
import { ContextArtifact } from './context-artifact.entity';
import { Repo } from '../entities/repo.entity';
import { DataSource } from 'typeorm';

const makeQuery = (rows: any[] = []) => jest.fn().mockResolvedValue(rows);

describe('ArtifactsService', () => {
  let service: ArtifactsService;
  let mockQuery: jest.Mock;
  let mockArtifactRepo: any;
  let mockRepoRepo: any;

  beforeEach(async () => {
    mockQuery = makeQuery();
    mockArtifactRepo = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockRepoRepo = {
      find: jest.fn().mockResolvedValue([{ id: 'default-repo-id', fullName: 'demo/codebase' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArtifactsService,
        { provide: getRepositoryToken(ContextArtifact), useValue: mockArtifactRepo },
        { provide: getRepositoryToken(Repo), useValue: mockRepoRepo },
        { provide: DataSource, useValue: { query: mockQuery } },
      ],
    }).compile();

    service = module.get<ArtifactsService>(ArtifactsService);
  });

  // ── isArtifact ────────────────────────────────────────────────────────────

  describe('isArtifact', () => {
    it('detects SQL schema files', () => {
      expect(service.isArtifact('db/schema.sql')).toBe('schema');
    });

    it('detects Prisma schema files', () => {
      expect(service.isArtifact('prisma/schema.prisma')).toBe('schema');
    });

    it('detects OpenAPI YAML files', () => {
      expect(service.isArtifact('openapi/swagger.yaml')).toBe('openapi');
    });

    it('detects swagger JSON files', () => {
      expect(service.isArtifact('api/swagger.json')).toBe('openapi');
    });

    it('detects Terraform .tf files', () => {
      expect(service.isArtifact('infra/main.tf')).toBe('terraform');
    });

    it('detects Terraform .tfvars files', () => {
      expect(service.isArtifact('infra/variables.tfvars')).toBe('terraform');
    });

    it('detects GraphQL schema files', () => {
      expect(service.isArtifact('src/schema.graphql')).toBe('graphql');
    });

    it('detects Protobuf files', () => {
      expect(service.isArtifact('proto/user.proto')).toBe('proto');
    });

    it('detects architecture markdown in docs folder', () => {
      expect(service.isArtifact('docs/architecture.md')).toBe('markdown');
    });

    it('returns null for regular TypeScript source files', () => {
      expect(service.isArtifact('src/app.service.ts')).toBeNull();
    });

    it('returns null for test files', () => {
      expect(service.isArtifact('src/app.spec.ts')).toBeNull();
    });

    it('returns null for node_modules', () => {
      expect(service.isArtifact('node_modules/express/index.js')).toBeNull();
    });

    it('returns null for package.json', () => {
      expect(service.isArtifact('package.json')).toBeNull();
    });

    it('returns null for dist files', () => {
      expect(service.isArtifact('dist/main.js')).toBeNull();
    });
  });

  // ── upsertArtifacts ───────────────────────────────────────────────────────

  describe('upsertArtifacts', () => {
    it('upserts a single artifact successfully', async () => {
      mockQuery.mockResolvedValue([]);
      const result = await service.upsertArtifacts([
        {
          repoId: 'repo-1',
          artifactType: 'schema',
          filePath: 'db/schema.sql',
          content: 'CREATE TABLE users (id SERIAL PRIMARY KEY);',
          commitSha: 'abc123',
        },
      ]);
      expect(result.upserted).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('upserts multiple artifacts', async () => {
      mockQuery.mockResolvedValue([]);
      const result = await service.upsertArtifacts([
        { repoId: 'r1', artifactType: 'schema', filePath: 'a.sql', content: 'SELECT 1' },
        { repoId: 'r1', artifactType: 'terraform', filePath: 'main.tf', content: 'resource {}' },
        { repoId: 'r1', artifactType: 'openapi', filePath: 'api.yaml', content: 'openapi: 3.0' },
      ]);
      expect(result.upserted).toBe(3);
    });

    it('handles upsert errors gracefully', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));
      const result = await service.upsertArtifacts([
        { artifactType: 'schema', filePath: 'bad.sql', content: 'bad sql' },
      ]);
      expect(result.upserted).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('bad.sql');
    });

    it('returns duration in ms', async () => {
      mockQuery.mockResolvedValue([]);
      const result = await service.upsertArtifacts([
        { artifactType: 'schema', filePath: 'a.sql', content: 'x' },
      ]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles empty array', async () => {
      const result = await service.upsertArtifacts([]);
      expect(result.upserted).toBe(0);
    });

    it('handles artifact without repoId', async () => {
      mockQuery.mockResolvedValue([]);
      const result = await service.upsertArtifacts([
        { artifactType: 'schema', filePath: 'schema.sql', content: 'SELECT 1' },
      ]);
      expect(result.upserted).toBe(1);
    });
  });

  // ── searchArtifacts ───────────────────────────────────────────────────────

  describe('searchArtifacts', () => {
    const mockRows = [
      {
        id: 'a1',
        repoId: 'r1',
        artifactType: 'schema',
        filePath: 'db/schema.sql',
        content: 'CREATE TABLE users',
        metadata: null,
        similarity: 0.85,
      },
    ];

    it('returns search results', async () => {
      mockQuery.mockResolvedValue(mockRows);
      const results = await service.searchArtifacts('users table');
      expect(results).toHaveLength(1);
      expect(results[0].artifactType).toBe('schema');
    });

    it('passes repoId filter', async () => {
      mockQuery.mockResolvedValue(mockRows);
      await service.searchArtifacts('users', { repoId: 'r1' });
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('repo_id');
    });

    it('passes artifactType filter', async () => {
      mockQuery.mockResolvedValue(mockRows);
      await service.searchArtifacts('users', { artifactType: 'schema' });
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('artifact_type');
    });

    it('returns empty array when no results', async () => {
      mockQuery.mockResolvedValue([]);
      const results = await service.searchArtifacts('nonexistent');
      expect(results).toHaveLength(0);
    });
  });

  // ── getArtifacts ──────────────────────────────────────────────────────────

  describe('getArtifacts', () => {
    it('fetches artifacts for a repo', async () => {
      const mockArtifacts = [
        { id: 'a1', repoId: 'r1', artifactType: 'schema', filePath: 'db/schema.sql', content: 'x' },
      ];
      mockArtifactRepo.find.mockResolvedValue(mockArtifacts);
      const result = await service.getArtifacts('r1');
      expect(result).toHaveLength(1);
      expect(mockArtifactRepo.find).toHaveBeenCalledWith({
        where: [{ repoId: 'r1' }],
        order: { filePath: 'ASC' },
      });
    });

    it('fetches artifacts filtered by type', async () => {
      mockArtifactRepo.find.mockResolvedValue([]);
      await service.getArtifacts('r1', 'schema');
      expect(mockArtifactRepo.find).toHaveBeenCalledWith({
        where: [{ repoId: 'r1', artifactType: 'schema' }],
        order: { filePath: 'ASC' },
      });
    });

    it('uses first active repo when repoId is omitted', async () => {
      mockArtifactRepo.find.mockResolvedValue([]);
      await service.getArtifacts(undefined, 'markdown');
      expect(mockRepoRepo.find).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { createdAt: 'ASC' },
        take: 1,
      });
      const callArg = mockArtifactRepo.find.mock.calls[0][0];
      expect(callArg.order).toEqual({ filePath: 'ASC' });
      expect(callArg.where).toHaveLength(2);
      expect(callArg.where[0]).toEqual({ repoId: 'default-repo-id', artifactType: 'markdown' });
      expect(callArg.where[1]).toMatchObject({ artifactType: 'markdown' });
      expect(callArg.where[1].repoId).toHaveProperty('_type', 'isNull');
    });
  });

  // ── getArtifactStats ──────────────────────────────────────────────────────

  describe('getArtifactStats', () => {
    it('returns stats grouped by type', async () => {
      mockQuery.mockResolvedValue([
        { artifact_type: 'schema', count: '3' },
        { artifact_type: 'terraform', count: '1' },
      ]);
      const stats = await service.getArtifactStats();
      expect(stats).toHaveLength(2);
      expect(stats[0].type).toBe('schema');
      expect(stats[0].count).toBe(3);
    });

    it('filters by repoId when provided', async () => {
      mockQuery.mockResolvedValue([]);
      await service.getArtifactStats('r1');
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('WHERE repo_id');
    });
  });

  // ── deleteRepoArtifacts ───────────────────────────────────────────────────

  describe('deleteRepoArtifacts', () => {
    it('deletes artifacts for a repo', async () => {
      mockArtifactRepo.delete.mockResolvedValue({ affected: 5 });
      const deleted = await service.deleteRepoArtifacts('r1');
      expect(deleted).toBe(5);
    });

    it('returns 0 when nothing deleted', async () => {
      mockArtifactRepo.delete.mockResolvedValue({ affected: 0 });
      const deleted = await service.deleteRepoArtifacts('nonexistent');
      expect(deleted).toBe(0);
    });
  });
});
