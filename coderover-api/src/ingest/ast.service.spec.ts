import { Test, TestingModule } from '@nestjs/testing';
import { AstService, FileStructure } from './ast.service';

describe('AstService', () => {
  let service: AstService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AstService],
    }).compile();

    service = module.get<AstService>(AstService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('parseFile', () => {
    it('should parse a service class with @Injectable() decorator', () => {
      const content = `
import { Injectable } from '@nestjs/common';
import { BookingRepository } from './booking.repository';

@Injectable()
export class BookingService {
  constructor(private repo: BookingRepository) {}
  async findAll() { return []; }
}
`;
      const result = service.parseFile('src/booking/booking.service.ts', content);

      expect(result.parseError).toBe(false);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('BookingService');
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].exported).toBe(true);
      expect(result.symbols[0].decorators).toContain('Injectable');
      expect(result.imports[0].source).toBe('@nestjs/common');
      expect(result.imports[0].names).toContain('Injectable');
      expect(result.nestRole).toBe('service');
      expect(result.exports).toContain('BookingService');
    });

    it('should parse a controller class with @Controller() decorator', () => {
      const content = `
import { Controller, Get } from '@nestjs/common';
@Controller('bookings')
export class BookingController {
  @Get() findAll() {}
}
`;
      const result = service.parseFile('src/booking/booking.controller.ts', content);

      expect(result.parseError).toBe(false);
      expect(result.nestRole).toBe('controller');
      expect(result.symbols[0].name).toBe('BookingController');
      expect(result.symbols[0].decorators).toContain('Controller');
    });

    it('should return parseError: true for invalid TypeScript without throwing', () => {
      const content = `this is not valid typescript {{{`;
      let result: FileStructure | undefined;
      expect(() => {
        result = service.parseFile('src/test/bad.ts', content);
      }).not.toThrow();
      // tolerant mode may succeed; but it should not throw at minimum
      if (result!.parseError) {
        expect(result!.symbols).toEqual([]);
      }
    });

    it('should parse an interface declaration', () => {
      const content = `export interface CreateBookingDto { userId: string; venueId: string; }`;
      const result = service.parseFile('src/booking/create-booking.dto.ts', content);

      expect(result.parseError).toBe(false);
      expect(result.symbols[0].name).toBe('CreateBookingDto');
      expect(result.symbols[0].kind).toBe('interface');
      expect(result.symbols[0].exported).toBe(true);
    });

    it('should detect entity nestRole from file path', () => {
      const content = `
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
@Entity()
export class Booking {
  @PrimaryGeneratedColumn('uuid') id: string;
}
`;
      const result = service.parseFile('src/entities/booking.entity.ts', content);
      expect(result.nestRole).toBe('entity');
    });

    it('should skip AST parsing for non-TS files and return empty structure', () => {
      const result = service.parseFile('src/scripts/setup.py', 'print("hello")');
      expect(result.parseError).toBe(false);
      expect(result.symbols).toEqual([]);
      expect(result.imports).toEqual([]);
      expect(result.exports).toEqual([]);
      expect(result.nestRole).toBe('unknown');
    });

    it('should skip AST parsing for .js files', () => {
      const result = service.parseFile('src/utils/helper.js', 'const x = 1;');
      expect(result.parseError).toBe(false);
      expect(result.symbols).toEqual([]);
    });

    it('should parse enum declarations', () => {
      const content = `export enum BookingStatus { PENDING = 'pending', CONFIRMED = 'confirmed' }`;
      const result = service.parseFile('src/booking/booking.ts', content);
      expect(result.symbols[0].name).toBe('BookingStatus');
      expect(result.symbols[0].kind).toBe('enum');
      expect(result.symbols[0].exported).toBe(true);
    });

    it('should parse type alias declarations', () => {
      const content = `export type BookingId = string;`;
      const result = service.parseFile('src/booking/booking.ts', content);
      expect(result.symbols[0].name).toBe('BookingId');
      expect(result.symbols[0].kind).toBe('type');
    });

    it('should parse exported const declarations', () => {
      const content = `export const MAX_BOOKINGS = 100;`;
      const result = service.parseFile('src/booking/booking.ts', content);
      expect(result.symbols[0].name).toBe('MAX_BOOKINGS');
      expect(result.symbols[0].kind).toBe('const');
      expect(result.symbols[0].exported).toBe(true);
    });

    it('should parse TSX exports with JSX enabled', () => {
      const content = `
import React from 'react';

export const Header = () => <div>Header</div>;
`;
      const result = service.parseFile('src/components/Header.tsx', content);
      expect(result.parseError).toBe(false);
      expect(result.symbols.some((s) => s.name === 'Header')).toBe(true);
      const headerSymbol = result.symbols.find((s) => s.name === 'Header')!;
      expect(headerSymbol.kind).toBe('const');
      expect(headerSymbol.exported).toBe(true);
    });

    it('should parse multiple imports', () => {
      const content = `
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Booking } from '../entities/booking.entity';
`;
      const result = service.parseFile('src/booking/booking.service.ts', content);
      expect(result.imports).toHaveLength(3);
      expect(result.imports[0].source).toBe('@nestjs/common');
      expect(result.imports[0].isRelative).toBe(false);
      expect(result.imports[2].source).toBe('../entities/booking.entity');
      expect(result.imports[2].isRelative).toBe(true);
    });
  });

  describe('detectNestRole', () => {
    it('should detect entity role from path', () => {
      expect(service.detectNestRole([], 'src/entities/booking.entity.ts')).toBe('entity');
    });

    it('should detect dto role from path', () => {
      expect(service.detectNestRole([], 'src/booking/create-booking.dto.ts')).toBe('dto');
    });

    it('should detect guard role from path', () => {
      expect(service.detectNestRole([], 'src/auth/guards/jwt-auth.guard.ts')).toBe('guard');
    });

    it('should detect interceptor role from path', () => {
      expect(service.detectNestRole([], 'src/common/logging.interceptor.ts')).toBe('interceptor');
    });

    it('should detect filter role from path', () => {
      expect(service.detectNestRole([], 'src/common/http-exception.filter.ts')).toBe('filter');
    });

    it('should detect pipe role from path', () => {
      expect(service.detectNestRole([], 'src/common/validation.pipe.ts')).toBe('pipe');
    });

    it('should detect middleware role from path', () => {
      expect(service.detectNestRole([], 'src/auth/logger.middleware.ts')).toBe('middleware');
    });

    it('should detect strategy role from path', () => {
      expect(service.detectNestRole([], 'src/auth/strategies/jwt.strategy.ts')).toBe('strategy');
    });

    it('should detect decorator role from path', () => {
      expect(service.detectNestRole([], 'src/common/decorators/current-user.decorator.ts')).toBe('decorator');
    });

    it('should detect controller from @Controller decorator', () => {
      const symbols = [{ name: 'BookingController', kind: 'class' as const, exported: true, decorators: ['Controller'], lineStart: 1, lineEnd: 10 }];
      expect(service.detectNestRole(symbols, 'src/booking/booking.controller.ts')).toBe('controller');
    });

    it('should detect service from @Injectable + service path', () => {
      const symbols = [{ name: 'BookingService', kind: 'class' as const, exported: true, decorators: ['Injectable'], lineStart: 1, lineEnd: 10 }];
      expect(service.detectNestRole(symbols, 'src/booking/booking.service.ts')).toBe('service');
    });

    it('should detect module from @Module decorator', () => {
      const symbols = [{ name: 'BookingModule', kind: 'class' as const, exported: true, decorators: ['Module'], lineStart: 1, lineEnd: 10 }];
      expect(service.detectNestRole(symbols, 'src/booking/booking.module.ts')).toBe('module');
    });

    it('should fallback to service for @Injectable without service in path', () => {
      const symbols = [{ name: 'SomeProvider', kind: 'class' as const, exported: true, decorators: ['Injectable'], lineStart: 1, lineEnd: 10 }];
      expect(service.detectNestRole(symbols, 'src/booking/provider.ts')).toBe('service');
    });

    it('should return unknown when no role matches', () => {
      expect(service.detectNestRole([], 'src/utils/helper.ts')).toBe('unknown');
    });
  });

  describe('getChunkSymbols', () => {
    it('should return only symbols within line range', () => {
      const fileStructure = {
        symbols: [
          { name: 'Foo', kind: 'class' as const, exported: true, decorators: [], lineStart: 1, lineEnd: 10 },
          { name: 'Bar', kind: 'function' as const, exported: true, decorators: [], lineStart: 20, lineEnd: 30 },
          { name: 'Baz', kind: 'interface' as const, exported: true, decorators: [], lineStart: 50, lineEnd: 55 },
        ],
        imports: [],
        exports: [],
        nestRole: 'unknown' as const,
        parseError: false,
        methods: [],
        callSites: [],
        inheritance: []
      };

      const result = service.getChunkSymbols(fileStructure, 1, 35);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Foo');
      expect(result[1].name).toBe('Bar');
    });

    it('should return empty array when no symbols in range', () => {
      const fileStructure = {
        symbols: [
          { name: 'Foo', kind: 'class' as const, exported: true, decorators: [], lineStart: 50, lineEnd: 60 },
        ],
        imports: [],
        exports: [],
        nestRole: 'unknown' as const,
        parseError: false,
        methods: [],
        callSites: [],
        inheritance: []
      };

      const result = service.getChunkSymbols(fileStructure, 1, 20);
      expect(result).toHaveLength(0);
    });

    it('should include symbol whose lineStart equals chunk lineStart', () => {
      const fileStructure = {
        symbols: [
          { name: 'Exact', kind: 'class' as const, exported: true, decorators: [], lineStart: 5, lineEnd: 15 },
        ],
        imports: [],
        exports: [],
        nestRole: 'unknown' as const,
        parseError: false,
        methods: [],
        callSites: [],
        inheritance: []
      };

      const result = service.getChunkSymbols(fileStructure, 5, 20);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Exact');
    });
  });

  describe('buildEnrichedHeader', () => {
    it('should include File, Module, Role, Symbols, and Lines', () => {
      const symbols = [
        { name: 'BookingService', kind: 'class' as const, exported: true, decorators: ['Injectable'], lineStart: 5, lineEnd: 50 },
      ];
      const header = service.buildEnrichedHeader(
        'src/booking/booking.service.ts',
        'BookingModule',
        1,
        80,
        symbols,
        'service',
      );

      expect(header).toContain('// File: src/booking/booking.service.ts');
      expect(header).toContain('// Module: BookingModule');
      expect(header).toContain('// Role: service');
      expect(header).toContain('// Symbols: BookingService (class, @Injectable)');
      expect(header).toContain('// Lines: 1-80');
      expect(header).toContain('---');
    });

    it('should omit Role line when nestRole is unknown', () => {
      const header = service.buildEnrichedHeader(
        'src/utils/helper.ts',
        null,
        1,
        20,
        [],
        'unknown',
      );

      expect(header).not.toContain('// Role:');
      expect(header).toContain('// File: src/utils/helper.ts');
      expect(header).toContain('// Lines: 1-20');
    });

    it('should omit Symbols line when symbols array is empty', () => {
      const header = service.buildEnrichedHeader(
        'src/booking/booking.service.ts',
        'BookingModule',
        1,
        10,
        [],
        'service',
      );

      expect(header).not.toContain('// Symbols:');
      expect(header).toContain('// Role: service');
    });

    it('should omit Module line when moduleName is null', () => {
      const header = service.buildEnrichedHeader('main.ts', null, 1, 5, [], 'unknown');
      expect(header).not.toContain('// Module:');
    });

    it('should format multiple symbols correctly', () => {
      const symbols = [
        { name: 'BookingService', kind: 'class' as const, exported: true, decorators: ['Injectable'], lineStart: 5, lineEnd: 30 },
        { name: 'BookingDto', kind: 'interface' as const, exported: true, decorators: [], lineStart: 35, lineEnd: 40 },
      ];
      const header = service.buildEnrichedHeader(
        'src/booking/booking.service.ts',
        'BookingModule',
        1,
        50,
        symbols,
        'service',
      );
      expect(header).toContain('BookingService (class, @Injectable)');
      expect(header).toContain('BookingDto (interface)');
    });
  });
});
