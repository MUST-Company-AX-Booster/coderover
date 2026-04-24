import { Test, TestingModule } from '@nestjs/testing';
import { ChunkerService, FileToChunk } from './chunker.service';
import { AstService } from './ast.service';
import { MultiLangAstService } from './languages/multi-lang-ast.service';
import { LanguageDetectorService } from './languages/language-detector.service';

describe('ChunkerService', () => {
  let service: ChunkerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChunkerService, AstService, MultiLangAstService, LanguageDetectorService],
    }).compile();
    // Init multi-lang parsers
    const mlAst = module.get<MultiLangAstService>(MultiLangAstService);
    mlAst.onModuleInit();

    service = module.get<ChunkerService>(ChunkerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('shouldIndex', () => {
    it('should filter out .spec.ts files', () => {
      expect(service.shouldIndex('src/booking/booking.service.spec.ts')).toBe(false);
    });

    it('should filter out .test.ts files', () => {
      expect(service.shouldIndex('src/utils/helper.test.ts')).toBe(false);
    });

    it('should filter out node_modules', () => {
      expect(service.shouldIndex('node_modules/@nestjs/core/index.ts')).toBe(false);
    });

    it('should filter out dist directory', () => {
      expect(service.shouldIndex('dist/main.js')).toBe(false);
    });

    it('should filter out .json files', () => {
      expect(service.shouldIndex('package.json')).toBe(false);
    });

    it('should index .md documentation files', () => {
      expect(service.shouldIndex('README.md')).toBe(true);
    });

    it('should filter out migration files', () => {
      expect(service.shouldIndex('src/database/migrations/001_initial.ts')).toBe(false);
    });

    it('should filter out dotfiles', () => {
      expect(service.shouldIndex('.gitignore')).toBe(false);
      expect(service.shouldIndex('src/.eslintrc.js')).toBe(false);
      expect(service.shouldIndex('solopay-demo/.env.local')).toBe(false);
      expect(service.shouldIndex('.DS_Store')).toBe(false);
    });

    it('should allow regular .ts source files', () => {
      expect(service.shouldIndex('src/booking/booking.service.ts')).toBe(true);
    });

    it('should allow controller files', () => {
      expect(service.shouldIndex('src/auth/auth.controller.ts')).toBe(true);
    });
  });

  describe('deriveModuleName', () => {
    it('should derive BookingModule from src/booking/booking.service.ts', () => {
      expect(service.deriveModuleName('src/booking/booking.service.ts')).toBe('BookingModule');
    });

    it('should derive WalletModule from src/wallet/wallet.controller.ts', () => {
      expect(service.deriveModuleName('src/wallet/wallet.controller.ts')).toBe('WalletModule');
    });

    it('should derive AuthModule from src/auth/strategies/jwt.strategy.ts', () => {
      expect(service.deriveModuleName('src/auth/strategies/jwt.strategy.ts')).toBe('AuthModule');
    });

    it('should return null for files outside src/', () => {
      expect(service.deriveModuleName('lib/utils.ts')).toBeNull();
    });

    it('should return null for root-level src files', () => {
      expect(service.deriveModuleName('main.ts')).toBeNull();
    });
  });

  describe('chunkFile', () => {
    it('should produce multiple chunks for a file with 5000 chars', () => {
      const lines: string[] = [];
      // Generate ~5000 chars of content (~63 lines of 80 chars each)
      for (let i = 0; i < 63; i++) {
        lines.push('x'.repeat(79));
      }
      const content = lines.join('\n');

      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should prepend context header to each chunk', () => {
      const content = 'const x = 1;\nconst y = 2;\nconst z = 3;';
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].chunkText).toContain('// File: src/booking/booking.service.ts');
      expect(chunks[0].chunkText).toContain('// Module: BookingModule');
      expect(chunks[0].chunkText).toContain('// Lines:');
      expect(chunks[0].chunkText).toContain('---');
    });

    it('should have accurate line numbers', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
      const content = lines.join('\n');

      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks[0].lineStart).toBe(1);
      expect(chunks[0].lineEnd).toBeGreaterThanOrEqual(1);
    });

    it('should return empty array for excluded files', () => {
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.spec.ts',
        content: 'some test content',
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks).toEqual([]);
    });

    it('should return empty array for empty content', () => {
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content: '',
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks).toEqual([]);
    });

    it('should track rawText without header', () => {
      const content = 'const x = 1;';
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks[0].rawText).toBe('const x = 1;');
      expect(chunks[0].chunkText).not.toBe(chunks[0].rawText);
    });

    it('should have overlapping content between consecutive chunks', () => {
      // Create content large enough to produce multiple chunks
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`const variable${i} = 'value ${i}';`);
      }
      const content = lines.join('\n');

      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      if (chunks.length >= 2) {
        // The second chunk should start before the first chunk ends
        // (overlap means lineStart of chunk 2 < lineEnd of chunk 1 + 1)
        expect(chunks[1].lineStart).toBeLessThanOrEqual(chunks[0].lineEnd);
      }
    });

    it('should set correct commitSha on all chunks', () => {
      const content = 'const x = 1;\nconst y = 2;';
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'sha256hash',
      };

      const chunks = service.chunkFile(file);
      chunks.forEach((chunk) => {
        expect(chunk.commitSha).toBe('sha256hash');
      });
    });

    it('should populate symbols and nestRole on TypeScript file chunks', () => {
      const content = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class BookingService {
  findAll() { return []; }
}
`;
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks.length).toBeGreaterThan(0);
      // nestRole should be populated
      expect(chunks[0].nestRole).toBe('service');
      // imports should be populated (file-level)
      expect(chunks[0].imports).toBeDefined();
      expect(Array.isArray(chunks[0].imports)).toBe(true);
    });

    it('should produce chunks with empty symbols for non-TS files', () => {
      const content = 'print("hello world")';
      const file: FileToChunk = {
        filePath: 'src/scripts/setup.py',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      if (chunks.length > 0) {
        expect(chunks[0].symbols).toEqual([]);
        expect(chunks[0].nestRole).toBe('unknown');
      }
    });

    it('should include Role line in enriched header for service files', () => {
      const content = `
import { Injectable } from '@nestjs/common';
@Injectable()
export class BookingService {
  findAll() { return []; }
}
`;
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].chunkText).toContain('// Role: service');
    });

    it('should include Symbols line in enriched header when symbols present', () => {
      const content = `
import { Injectable } from '@nestjs/common';
@Injectable()
export class BookingService {
  findAll() { return []; }
}
`;
      const file: FileToChunk = {
        filePath: 'src/booking/booking.service.ts',
        content,
        commitSha: 'abc123',
      };

      const chunks = service.chunkFile(file);
      expect(chunks.length).toBeGreaterThan(0);
      // At least one chunk should have BookingService symbol in header
      const hasSymbolLine = chunks.some((c) => c.chunkText.includes('// Symbols:'));
      expect(hasSymbolLine).toBe(true);
    });
  });
});
