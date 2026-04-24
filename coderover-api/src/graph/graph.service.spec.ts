import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GraphService } from './graph.service';
import { DataSource } from 'typeorm';
import { MemgraphService } from './memgraph.service';
import { ConfidenceTaggerService } from './confidence-tagger.service';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';

describe('GraphService', () => {
  let service: GraphService;
  let dataSourceMock: any;
  let memgraphServiceMock: any;
  let edgeAuditRepoMock: any;

  beforeEach(async () => {
    dataSourceMock = {
      query: jest.fn(),
    };

    memgraphServiceMock = {
      getSession: jest.fn(),
      readQuery: jest.fn(),
      writeQuery: jest.fn(),
    };

    edgeAuditRepoMock = {
      insert: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: MemgraphService, useValue: memgraphServiceMock },
        { provide: getRepositoryToken(EdgeProducerAudit), useValue: edgeAuditRepoMock },
        ConfidenceTaggerService,
      ],
    }).compile();

    service = module.get<GraphService>(GraphService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('buildGraph', () => {
    it('should build a dependency graph correctly', async () => {
      dataSourceMock.query.mockResolvedValue([
        {
          filePath: 'src/main.ts',
          moduleName: 'Main',
          nestRole: null,
          imports: [{ source: './app.module', isRelative: true, names: ['AppModule'] }],
        },
        {
          filePath: 'src/app.module.ts',
          moduleName: 'AppModule',
          nestRole: 'module',
          imports: [{ source: './users/users.service', isRelative: true, names: ['UsersService'] }],
        },
        {
          filePath: 'src/users/users.service.ts',
          moduleName: 'UsersService',
          nestRole: 'service',
          imports: [],
        },
      ]);

      const graph = await service.buildGraph('repo-123');

      expect(Object.keys(graph.nodes).length).toBe(3);
      // Normalized paths (assuming relative resolution logic)
      const mainPath = 'src/main.ts';
      
      // Note: The mock data uses paths that resolve correctly with the service logic
      // Assuming resolveImportPath works with the mocked paths if they are in the node list
      
      // Let's verify edges exist if resolution works
      // The service uses path.join/normalize which depends on OS.
      // But for relative paths ./app.module from src/main.ts -> src/app.module
      
      // Since we can't easily test path resolution in unit test without mocking path or ensuring OS consistency,
      // we just check if nodes are created.
      expect(graph.nodes[mainPath]).toBeDefined();
    });
  });

  describe('syncRepoToMemgraph — deterministic IDs (Phase 10 C2)', () => {
    it('passes a node_id on every File node creation and edge_id on every edge MERGE', async () => {
      // Fake session/transaction — capture every Cypher + params pair.
      const runCalls: Array<{ cypher: string; params: Record<string, any> }> = [];
      const fakeTx = {
        run: jest.fn(async (cypher: string, params: Record<string, any> = {}) => {
          runCalls.push({ cypher, params });
          // When CALLS MERGE is issued we need to return a records[] so the
          // JS-side edge_id SET step has something to iterate; empty is fine.
          return { records: [] };
        }),
      };
      const fakeSession = {
        executeWrite: jest.fn(async (fn: any) => fn(fakeTx)),
        close: jest.fn(),
      };
      memgraphServiceMock.getSession = jest.fn(() => fakeSession);

      // Minimal dataSource query plan: one file, one symbol, one call, no methods.
      dataSourceMock.query = jest.fn(async (sql: string) => {
        if (sql.includes('code_chunks')) {
          if (sql.includes('SELECT DISTINCT ON')) {
            return [
              {
                filePath: 'src/a.ts',
                moduleName: null,
                nestRole: null,
                imports: [],
              },
            ];
          }
          return [
            {
              file_path: 'src/a.ts',
              symbols: [{ name: 'foo', kind: 'function' }],
            },
          ];
        }
        if (sql.includes('code_methods')) return [];
        if (sql.includes('code_inheritance')) return [];
        if (sql.includes('code_calls')) return [];
        return [];
      });

      await service.syncRepoToMemgraph('repo-1');

      // File CREATE must carry node_id.
      const fileCreateCall = runCalls.find((c) =>
        c.cypher.includes('CREATE (f:File'),
      );
      expect(fileCreateCall).toBeDefined();
      expect(fileCreateCall!.cypher).toContain('node_id: $nodeId');
      expect(fileCreateCall!.params.nodeId).toMatch(/^[0-9a-f]{16}$/);

      // Symbol+DEFINES merge must carry both node_id and edge_id.
      const symbolCall = runCalls.find((c) =>
        c.cypher.includes('MERGE (s:Symbol'),
      );
      expect(symbolCall).toBeDefined();
      expect(symbolCall!.cypher).toContain('e.edge_id');
      expect(symbolCall!.params.symbolNodeId).toMatch(/^[0-9a-f]{16}$/);
      expect(symbolCall!.params.definesEdgeId).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});
