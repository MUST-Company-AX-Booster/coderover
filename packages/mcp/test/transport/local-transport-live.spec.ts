/**
 * LocalTransport — Wave 3 live-mode integration test.
 *
 * Wires LocalTransport with a real SQLite DB + MockEmbedder + the Wave 3
 * query modules. Asserts that `callTool` returns the exact shapes the
 * remote transport contract expects. If the sqlite-vec native binary
 * can't load in this environment, the suite skips gracefully.
 */

import Database from 'better-sqlite3';
import { LocalTransport } from '../../src/transport/local-transport';
import { MockEmbedder } from '../../src/local/embed/embedder';
import { openDb } from '../../src/local/db/open';
import { migrate } from '../../src/local/db/migrator';
import { migration001Initial } from '../../src/local/db/migrations/001_initial';
import { migration002SqliteVec } from '../../src/local/db/migrations/002_sqlite_vec';
import { migration003CallEdges } from '../../src/local/db/migrations/003_call_edges';
import { loadSqliteVec } from '../../src/local/db/sqlite-vec';
import { computeNodeId } from '../../src/local/deterministic-ids';

function trySqliteVec(): boolean {
  try {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    db.close();
    return true;
  } catch {
    return false;
  }
}

const describeIfVec = trySqliteVec() ? describe : describe.skip;

describeIfVec('LocalTransport (live: real DB + MockEmbedder)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDb(':memory:');
    loadSqliteVec(db);
    await migrate(db, [
      migration001Initial,
      migration002SqliteVec,
      migration003CallEdges,
    ]);

    // Seed one chunk + one symbol + one import.
    const chunkId = 'chunk-1';
    db.prepare(
      `INSERT INTO code_chunks (id, file_path, line_start, line_end, content, language, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chunkId,
      'src/auth/auth.service.ts',
      1,
      40,
      'export class AuthService { validate() { /* ... */ } }',
      'typescript',
      'hash1',
    );

    const nodeId = computeNodeId('src/auth/auth.service.ts', 'class', 'AuthService');
    db.prepare(
      `INSERT INTO symbols (node_id, chunk_id, kind, name, qualified)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(nodeId, chunkId, 'class', 'AuthService', 'AuthService');

    // Seed the vec index with a MockEmbedder vector for the chunk content.
    const mock = new MockEmbedder(1536);
    // We can't use async in beforeEach easily; pre-compute synchronously via
    // the mock's deterministic derivation — call through await in the test.
  });

  afterEach(() => {
    db.close();
  });

  it('routes find_symbol through the live SQL path', async () => {
    const transport = new LocalTransport({
      db,
      embedder: new MockEmbedder(1536),
    });
    const res = await transport.callTool('find_symbol', { symbolName: 'AuthService' });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.symbolName).toBe('AuthService');
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].filePath).toBe('src/auth/auth.service.ts');
    expect(payload.results[0].node_id).toBe(
      computeNodeId('src/auth/auth.service.ts', 'class', 'AuthService'),
    );
    expect(payload.results[0].confidence).toBe('EXTRACTED');
    expect(payload.totalFound).toBe(1);
  });

  it('routes find_dependencies through the live SQL path', async () => {
    db.prepare(
      `INSERT INTO imports (edge_id, src_file, target_path, confidence)
       VALUES (?, ?, ?, ?)`,
    ).run(
      'edge-1',
      'src/auth/auth.controller.ts',
      'src/auth/auth.service.ts',
      'EXTRACTED',
    );

    const transport = new LocalTransport({
      db,
      embedder: new MockEmbedder(1536),
    });
    const res = await transport.callTool('find_dependencies', {
      target: 'src/auth/auth.service.ts',
    });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.target).toBe('src/auth/auth.service.ts');
    expect(payload.upstream).toHaveLength(1);
    expect(payload.upstream[0].filePath).toBe('src/auth/auth.controller.ts');
    expect(payload.downstream).toEqual([]);
  });

  it('routes search_code through the live embed + KNN path', async () => {
    const embedder = new MockEmbedder(1536);
    // Seed the vec table with the chunk's content vector.
    const vec = (await embedder.embed({
      input: ['export class AuthService { validate() { /* ... */ } }'],
    })).vectors[0];
    db.prepare(
      `INSERT INTO code_chunks_vec (chunk_id, embedding) VALUES (?, vec_f32(?))`,
    ).run('chunk-1', JSON.stringify(vec));

    const transport = new LocalTransport({ db, embedder });
    const res = await transport.callTool('search_code', { query: 'AuthService' });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.query).toBe('AuthService');
    expect(payload.results.length).toBeGreaterThanOrEqual(1);
    expect(payload.results[0].confidence).toBe('EXTRACTED');
  });

  it('unknown tool returns isError', async () => {
    const transport = new LocalTransport({
      db,
      embedder: new MockEmbedder(1536),
    });
    const res = await transport.callTool('not_a_tool', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/);
  });

  // ─── 0.4.0 regressions ───────────────────────────────────────────────

  describe('input validation (0.4.0 — was B1: silent match-everything)', () => {
    it('find_symbol: empty symbolName returns InvalidArgument', async () => {
      const transport = new LocalTransport({
        db,
        embedder: new MockEmbedder(1536),
      });
      const res = await transport.callTool('find_symbol', { symbolName: '' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/InvalidArgument/);
      expect(res.content[0].text).toMatch(/symbolName/);
    });

    it('find_symbol: missing symbolName returns InvalidArgument', async () => {
      const transport = new LocalTransport({
        db,
        embedder: new MockEmbedder(1536),
      });
      const res = await transport.callTool('find_symbol', {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/InvalidArgument/);
    });

    it('find_symbol: whitespace-only symbolName returns InvalidArgument', async () => {
      const transport = new LocalTransport({
        db,
        embedder: new MockEmbedder(1536),
      });
      const res = await transport.callTool('find_symbol', { symbolName: '   ' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/InvalidArgument/);
    });

    it('search_code: empty query returns InvalidArgument', async () => {
      const transport = new LocalTransport({
        db,
        embedder: new MockEmbedder(1536),
      });
      const res = await transport.callTool('search_code', { query: '' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/InvalidArgument/);
      expect(res.content[0].text).toMatch(/query/);
    });

    it('find_dependencies: empty target returns InvalidArgument', async () => {
      const transport = new LocalTransport({
        db,
        embedder: new MockEmbedder(1536),
      });
      const res = await transport.callTool('find_dependencies', { target: '' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/InvalidArgument/);
      expect(res.content[0].text).toMatch(/target/);
    });
  });

  it('search_code stamps meta.embedder so agents can detect mock-mode results (0.4.0 — was B7)', async () => {
    const embedder = new MockEmbedder(1536);
    const vec = (
      await embedder.embed({
        input: ['export class AuthService { validate() { /* ... */ } }'],
      })
    ).vectors[0];
    db.prepare(
      `INSERT INTO code_chunks_vec (chunk_id, embedding) VALUES (?, vec_f32(?))`,
    ).run('chunk-1', JSON.stringify(vec));

    const transport = new LocalTransport({ db, embedder });
    const res = await transport.callTool('search_code', { query: 'AuthService' });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text) as { meta?: { embedder?: string } };
    expect(payload.meta?.embedder).toBe('mock');
  });
});
