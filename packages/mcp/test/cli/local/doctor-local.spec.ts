/**
 * Local-mode doctor tests.
 *
 * Everything is injected — no real sqlite-vec or better-sqlite3 native
 * binding is exercised. We build a `FakeDb` that returns scripted results
 * for each SQL we know the doctor issues, and feed every other filesystem
 * touch through a stub.
 */

import { PassThrough } from 'stream';
import {
  doctorLocal,
  type DbHandle,
  type DoctorLocalDeps,
  type InstalledLocalEntry,
} from '../../../src/cli/local/doctor-local';

/** Minimal FakeDb that answers the exact queries the doctor emits. */
class FakeDb implements DbHandle {
  private tables: Set<string>;
  private chunkCount: number;
  private fileHashes: Array<{ file_path: string; sha256: string }>;
  public closed = false;
  public schemaThrows = false;
  public countThrows = false;

  constructor(opts: {
    tables?: string[];
    chunkCount?: number;
    fileHashes?: Array<{ file_path: string; sha256: string }>;
  }) {
    this.tables = new Set(opts.tables ?? []);
    this.chunkCount = opts.chunkCount ?? 0;
    this.fileHashes = opts.fileHashes ?? [];
  }

  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  } {
    if (/sqlite_master/i.test(sql)) {
      return {
        all: () => {
          if (this.schemaThrows) throw new Error('db is locked');
          return [...this.tables].map((name) => ({ name }));
        },
        get: () => undefined,
      };
    }
    if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+code_chunks/i.test(sql)) {
      return {
        all: () => [],
        get: () => {
          if (this.countThrows) throw new Error('no such table');
          return { n: this.chunkCount };
        },
      };
    }
    if (/file_path.*sha256.*FROM\s+file_hashes/i.test(sql)) {
      return {
        all: () => this.fileHashes,
        get: () => undefined,
      };
    }
    return { all: () => [], get: () => undefined };
  }

  close(): void {
    this.closed = true;
  }
}

const ALL_TABLES = ['code_chunks', 'symbols', 'imports', 'code_chunks_vec'];

function noopIo() {
  const out = new PassThrough();
  const err = new PassThrough();
  // drain so the streams don't back up
  out.on('data', () => undefined);
  err.on('data', () => undefined);
  return { out, err };
}

function goodDeps(
  dbOverride?: FakeDb,
  extra: Partial<DoctorLocalDeps> = {},
): DoctorLocalDeps {
  const db =
    dbOverride ??
    new FakeDb({ tables: ALL_TABLES, chunkCount: 42, fileHashes: [] });
  return {
    openDb: () => db,
    tryLoadSqliteVec: () => undefined,
    fileExists: async () => true,
    hashFile: async () => 'deadbeef',
    rand: () => 0,
    ...extra,
  };
}

describe('doctorLocal', () => {
  it('fails mcp-registered when no config entry exists', async () => {
    const io = noopIo();
    const r = await doctorLocal({ entry: null, env: {} }, {}, io);
    expect(r.passing).toBe(false);
    expect(r.checks[0]?.name).toBe('mcp-registered');
    expect(r.checks[0]?.ok).toBe(false);
  });

  it('fails mode-is-local when entry is remote', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = { mode: 'remote' };
    const r = await doctorLocal({ entry, env: {} }, {}, io);
    expect(r.passing).toBe(false);
    const mode = r.checks.find((c) => c.name === 'mode-is-local');
    expect(mode?.ok).toBe(false);
    expect(mode?.message).toMatch(/remote/);
  });

  it('fails db-exists when the DB file is missing', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/nope/x.db',
      embedMode: 'mock',
    };
    const deps: DoctorLocalDeps = {
      fileExists: async () => false,
      openDb: () => {
        throw new Error('should not open');
      },
    };
    const r = await doctorLocal({ entry, env: {} }, deps, io);
    expect(r.passing).toBe(false);
    const db = r.checks.find((c) => c.name === 'db-exists');
    expect(db?.ok).toBe(false);
    expect(db?.fix).toMatch(/index/);
  });

  it('fails db-schema when required tables are missing', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({ tables: ['code_chunks'] });
    const r = await doctorLocal({ entry, env: {} }, goodDeps(db), io);
    expect(r.passing).toBe(false);
    const schema = r.checks.find((c) => c.name === 'db-schema');
    expect(schema?.ok).toBe(false);
    expect(schema?.message).toMatch(/symbols/);
    expect(db.closed).toBe(true);
  });

  it('fails db-schema when probe throws (corrupt DB)', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({ tables: ALL_TABLES });
    db.schemaThrows = true;
    const r = await doctorLocal({ entry, env: {} }, goodDeps(db), io);
    expect(r.passing).toBe(false);
    const schema = r.checks.find((c) => c.name === 'db-schema');
    expect(schema?.ok).toBe(false);
    expect(schema?.message).toMatch(/probe failed/);
  });

  it('fails index-non-empty when code_chunks has 0 rows', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 0 });
    const r = await doctorLocal({ entry, env: {} }, goodDeps(db), io);
    expect(r.passing).toBe(false);
    const idx = r.checks.find((c) => c.name === 'index-non-empty');
    expect(idx?.ok).toBe(false);
    expect(idx?.fix).toMatch(/index/);
  });

  it('passes index-non-empty when DB has chunks', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 17 });
    const r = await doctorLocal({ entry, env: {} }, goodDeps(db), io);
    const idx = r.checks.find((c) => c.name === 'index-non-empty');
    expect(idx?.ok).toBe(true);
    expect(idx?.message).toMatch(/17/);
  });

  it('warns file-hashes-fresh (soft-fail) when a sampled file drifted', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({
      tables: ALL_TABLES,
      chunkCount: 5,
      fileHashes: [
        { file_path: '/a.ts', sha256: 'stored-hash' },
      ],
    });
    const deps: DoctorLocalDeps = {
      openDb: () => db,
      tryLoadSqliteVec: () => undefined,
      fileExists: async () => true,
      hashFile: async () => 'different-hash',
      rand: () => 0,
    };
    const r = await doctorLocal({ entry, env: {} }, deps, io);
    // warn should NOT flip passing → false (severity: warn).
    const fh = r.checks.find((c) => c.name === 'file-hashes-fresh');
    expect(fh?.ok).toBe(false);
    expect(fh?.severity).toBe('warn');
    expect(fh?.message).toMatch(/changed/);
    expect(r.passing).toBe(true);
  });

  it('marks file-hashes-fresh ok when all sampled files match', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({
      tables: ALL_TABLES,
      chunkCount: 5,
      fileHashes: [{ file_path: '/a.ts', sha256: 'matching-hash' }],
    });
    const deps: DoctorLocalDeps = {
      openDb: () => db,
      tryLoadSqliteVec: () => undefined,
      fileExists: async () => true,
      hashFile: async () => 'matching-hash',
      rand: () => 0,
    };
    const r = await doctorLocal({ entry, env: {} }, deps, io);
    const fh = r.checks.find((c) => c.name === 'file-hashes-fresh');
    expect(fh?.ok).toBe(true);
  });

  it('fails embedder-reachable for openai when OPENAI_API_KEY is unset', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'openai',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 1 });
    const r = await doctorLocal({ entry, env: {} }, goodDeps(db), io);
    const emb = r.checks.find((c) => c.name === 'embedder-reachable');
    expect(emb?.ok).toBe(false);
    expect(emb?.fix).toMatch(/OPENAI_API_KEY/);
    expect(r.passing).toBe(false);
  });

  it('passes embedder-reachable for openai when OPENAI_API_KEY is set', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'openai',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 1 });
    const r = await doctorLocal(
      { entry, env: { OPENAI_API_KEY: 'sk-test' } },
      goodDeps(db),
      io,
    );
    const emb = r.checks.find((c) => c.name === 'embedder-reachable');
    expect(emb?.ok).toBe(true);
  });

  it('passes embedder-reachable for mock mode without credentials', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 1 });
    const r = await doctorLocal({ entry, env: {} }, goodDeps(db), io);
    const emb = r.checks.find((c) => c.name === 'embedder-reachable');
    expect(emb?.ok).toBe(true);
  });

  it('passes embedder-reachable for offline mode when @xenova/transformers resolves', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'offline',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 1 });
    const r = await doctorLocal(
      { entry, env: {} },
      goodDeps(db, { canResolveModule: (id) => id === '@xenova/transformers' }),
      io,
    );
    const emb = r.checks.find((c) => c.name === 'embedder-reachable');
    expect(emb?.ok).toBe(true);
    expect(emb?.message).toMatch(/offline embedder ready/);
  });

  it('fails embedder-reachable for offline mode when the companion package is missing', async () => {
    // This is the exact upgrade scenario: a user on 0.2.x bumps to 0.3.0
    // but hasn't installed @coderover/mcp-offline yet. Doctor must catch
    // it at diagnosis time, not at first embed() call.
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'offline',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 1 });
    const r = await doctorLocal(
      { entry, env: {} },
      goodDeps(db, { canResolveModule: () => false }),
      io,
    );
    const emb = r.checks.find((c) => c.name === 'embedder-reachable');
    expect(emb?.ok).toBe(false);
    expect(emb?.fix).toMatch(/npm install @coderover\/mcp-offline/);
    expect(r.passing).toBe(false);
  });

  it('fails sqlite-vec-loadable when the load shim returns an error', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({ tables: ALL_TABLES, chunkCount: 1 });
    const deps: DoctorLocalDeps = {
      openDb: () => db,
      tryLoadSqliteVec: () => new Error('dlopen failed: incompatible arch'),
      fileExists: async () => true,
      hashFile: async () => 'x',
      rand: () => 0,
    };
    const r = await doctorLocal({ entry, env: {} }, deps, io);
    const v = r.checks.find((c) => c.name === 'sqlite-vec-loadable');
    expect(v?.ok).toBe(false);
    expect(v?.message).toMatch(/dlopen/);
    expect(r.passing).toBe(false);
  });

  it('returns passing=true when every check is green', async () => {
    const io = noopIo();
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    const db = new FakeDb({
      tables: ALL_TABLES,
      chunkCount: 100,
      fileHashes: [{ file_path: '/a.ts', sha256: 'h' }],
    });
    const deps: DoctorLocalDeps = {
      openDb: () => db,
      tryLoadSqliteVec: () => undefined,
      fileExists: async () => true,
      hashFile: async () => 'h',
      rand: () => 0,
    };
    const r = await doctorLocal({ entry, env: {} }, deps, io);
    expect(r.passing).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('renders ✓ / ✗ / ! marks to the io streams', async () => {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const out = new PassThrough();
    const err = new PassThrough();
    out.on('data', (c: Buffer) => outChunks.push(c.toString()));
    err.on('data', (c: Buffer) => errChunks.push(c.toString()));

    const entry: InstalledLocalEntry = { mode: 'remote' };
    await doctorLocal({ entry, env: {} }, {}, { out, err });
    // mode-is-local failure renders ✗
    const text = outChunks.join('') + errChunks.join('');
    expect(text).toMatch(/✓|✗/);
    expect(text).toMatch(/mode-is-local/);
  });

  it('closes the DB in the all-green path', async () => {
    const io = noopIo();
    const db = new FakeDb({
      tables: ALL_TABLES,
      chunkCount: 1,
      fileHashes: [],
    });
    const entry: InstalledLocalEntry = {
      mode: 'local',
      dbPath: '/x.db',
      embedMode: 'mock',
    };
    await doctorLocal({ entry, env: {} }, goodDeps(db), io);
    expect(db.closed).toBe(true);
  });
});
