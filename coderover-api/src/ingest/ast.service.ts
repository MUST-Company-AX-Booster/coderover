import { Injectable, Logger } from '@nestjs/common';
import { parse } from '@typescript-eslint/typescript-estree';

export interface SymbolInfo {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'enum' | 'type' | 'const' | 'variable';
  exported: boolean;
  decorators: string[];   // e.g. ['Injectable', 'Controller', 'Module']
  lineStart: number;
  lineEnd: number;
}

export interface ImportInfo {
  source: string;         // e.g. '../entities/booking.entity'
  names: string[];        // e.g. ['Booking', 'BookingStatus']
  isRelative: boolean;    // true if starts with '.' or '..'
}

export interface MethodInfo {
  name: string;
  className: string;
  startLine: number;
  endLine: number;
  parameters: string[];
}

export interface CallSiteInfo {
  callerName: string;          // function/method making the call
  callerKind: 'function' | 'method';
  calleeName: string;          // function/method being called
  calleeQualified: string;     // e.g., "this.userService.findOne" or "utils.hash"
  line: number;
}

export interface InheritanceInfo {
  className: string;
  extends: string | null;      // parent class
  implements: string[];        // implemented interfaces
}

export type NestRole =
  | 'controller'
  | 'service'
  | 'module'
  | 'guard'
  | 'interceptor'
  | 'filter'
  | 'pipe'
  | 'decorator'
  | 'entity'
  | 'dto'
  | 'middleware'
  | 'strategy'
  | 'unknown';

export interface FileStructure {
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: string[];      // names of exported symbols
  nestRole: NestRole;
  parseError: boolean;    // true if AST parsing failed (graceful degradation)
  
  // Entity-level graph data
  methods: MethodInfo[];
  callSites: CallSiteInfo[];
  inheritance: InheritanceInfo[];
}

@Injectable()
export class AstService {
  private readonly logger = new Logger(AstService.name);

  /**
   * Parse a TypeScript file and extract structural metadata.
   * Non-TS files are skipped (returns empty structure).
   * Parse errors are caught gracefully.
   */
  parseFile(filePath: string, content: string): FileStructure {
    // Non-TS files: skip parse entirely
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) {
      return { 
        symbols: [], imports: [], exports: [], nestRole: 'unknown', parseError: false,
        methods: [], callSites: [], inheritance: [] 
      };
    }

    let ast: any;
    try {
      const isTsx = filePath.endsWith('.tsx');
      ast = parse(content, {
        jsx: isTsx,
        loc: true,
        range: false,
        comment: false,
        tokens: false,
        errorOnUnknownASTType: false,
        tolerant: true,
        sourceType: 'module',
      });
    } catch (err) {
      this.logger.debug(`AST parse error for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return { 
        symbols: [], imports: [], exports: [], nestRole: 'unknown', parseError: true,
        methods: [], callSites: [], inheritance: []
      };
    }

    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: string[] = [];
    const methods: MethodInfo[] = [];
    const callSites: CallSiteInfo[] = [];
    const inheritance: InheritanceInfo[] = [];

    // Walk only top-level body nodes
    for (const node of ast.body ?? []) {
      this.processNode(node, symbols, imports, exports, methods, callSites, inheritance);
    }

    const nestRole = this.detectNestRole(symbols, filePath);

    return { symbols, imports, exports, nestRole, parseError: false, methods, callSites, inheritance };
  }

  private processNode(
    node: any,
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    exports: string[],
    methods: MethodInfo[],
    callSites: CallSiteInfo[],
    inheritance: InheritanceInfo[],
  ): void {
    switch (node.type) {
      case 'ImportDeclaration':
        this.processImport(node, imports);
        break;

      case 'ClassDeclaration':
      case 'ClassExpression': {
        const name = node.id?.name;
        if (name) {
          const decorators = this.extractDecorators(node);
          symbols.push({
            name,
            kind: 'class',
            exported: this.isExported(),
            decorators,
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          if (this.isExported()) exports.push(name);

          // Phase 7: Extract Inheritance
          this.processInheritance(node, name, inheritance);

          // Phase 7: Extract Methods & Call Sites
          this.processClassBody(node, name, methods, callSites);
        }
        break;
      }

      case 'FunctionDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'function',
            exported: this.isExported(),
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          if (this.isExported()) exports.push(name);

          // Phase 7: Extract Call Sites inside function
          this.extractCallSites(node.body, name, 'function', callSites);
        }
        break;
      }

      case 'TSInterfaceDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'interface',
            exported: this.isExported(),
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          if (this.isExported()) exports.push(name);
        }
        break;
      }

      case 'TSEnumDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'enum',
            exported: this.isExported(),
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          if (this.isExported()) exports.push(name);
        }
        break;
      }

      case 'TSTypeAliasDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'type',
            exported: this.isExported(),
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          if (this.isExported()) exports.push(name);
        }
        break;
      }

      case 'VariableDeclaration': {
        if (node.kind === 'const') {
          for (const declarator of node.declarations ?? []) {
            const name = declarator.id?.name;
            if (name) {
              symbols.push({
                name,
                kind: 'const',
                exported: false,
                decorators: [],
                lineStart: node.loc.start.line,
                lineEnd: node.loc.end.line,
              });
            }
          }
        }
        break;
      }

      case 'ExportNamedDeclaration': {
        // Process inner declaration if present
        if (node.declaration) {
          // Temporarily mark as exported by processing the inner node
          this.processExportedDeclaration(node.declaration, symbols, exports);
        }
        // Named specifiers (e.g. export { Foo, Bar })
        for (const specifier of node.specifiers ?? []) {
          const name = specifier.exported?.name;
          if (name && !exports.includes(name)) {
            exports.push(name);
          }
        }
        break;
      }

      case 'ExportDefaultDeclaration': {
        const inner = node.declaration;
        const named =
          inner?.type === 'ClassDeclaration' || inner?.type === 'FunctionDeclaration'
            ? inner.id?.name
            : undefined;
        if (named) {
          symbols.push({
            name: named,
            kind: inner.type === 'ClassDeclaration' ? 'class' : 'function',
            exported: true,
            decorators: inner.type === 'ClassDeclaration' ? this.extractDecorators(inner) : [],
            lineStart: inner.loc.start.line,
            lineEnd: inner.loc.end.line,
          });
          if (!exports.includes(named)) exports.push(named);
        } else if (inner?.type === 'Identifier' && inner.name) {
          if (!exports.includes(inner.name)) exports.push(inner.name);
        }
        break;
      }
    }
  }

  /**
   * Process a declaration that is wrapped in ExportNamedDeclaration.
   * Marks it as exported.
   */
  private processExportedDeclaration(
    node: any,
    symbols: SymbolInfo[],
    exports: string[],
  ): void {
    // Note: We don't extract methods/calls here because this function is currently 
    // only used for symbol extraction. The main loop calls processNode which 
    // handles ClassDeclaration and FunctionDeclaration cases (even if exported).
    // So we don't need to duplicate logic here.
    switch (node.type) {
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const name = node.id?.name;
        if (name) {
          const decorators = this.extractDecorators(node);
          symbols.push({
            name,
            kind: 'class',
            exported: true,
            decorators,
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          exports.push(name);
        }
        break;
      }
      case 'FunctionDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'function',
            exported: true,
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          exports.push(name);
        }
        break;
      }
      case 'TSInterfaceDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'interface',
            exported: true,
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          exports.push(name);
        }
        break;
      }
      case 'TSEnumDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'enum',
            exported: true,
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          exports.push(name);
        }
        break;
      }
      case 'TSTypeAliasDeclaration': {
        const name = node.id?.name;
        if (name) {
          symbols.push({
            name,
            kind: 'type',
            exported: true,
            decorators: [],
            lineStart: node.loc.start.line,
            lineEnd: node.loc.end.line,
          });
          exports.push(name);
        }
        break;
      }
      case 'VariableDeclaration': {
        for (const declarator of node.declarations ?? []) {
          const name = declarator.id?.name;
          if (name) {
            symbols.push({
              name,
              kind: node.kind === 'const' ? 'const' : 'variable',
              exported: true,
              decorators: [],
              lineStart: node.loc.start.line,
              lineEnd: node.loc.end.line,
            });
            exports.push(name);
          }
        }
        break;
      }
    }
  }

  /**
   * Extract class inheritance (extends / implements).
   */
  private processInheritance(
    node: any,
    className: string,
    inheritance: InheritanceInfo[],
  ): void {
    let superClass: string | null = null;
    const implemented: string[] = [];

    if (node.superClass) {
      if (node.superClass.type === 'Identifier') {
        superClass = node.superClass.name;
      } else if (node.superClass.type === 'MemberExpression') {
        // e.g. React.Component
        superClass = `${node.superClass.object?.name}.${node.superClass.property?.name}`;
      }
    }

    if (node.implements && Array.isArray(node.implements)) {
      for (const impl of node.implements) {
        if (impl.expression?.type === 'Identifier') {
          implemented.push(impl.expression.name);
        }
      }
    }

    if (superClass || implemented.length > 0) {
      inheritance.push({
        className,
        extends: superClass,
        implements: implemented,
      });
    }
  }

  /**
   * Process class body to find methods and their call sites.
   */
  private processClassBody(
    classNode: any,
    className: string,
    methods: MethodInfo[],
    callSites: CallSiteInfo[],
  ): void {
    const body = classNode.body?.body || [];
    for (const member of body) {
      if (member.type === 'MethodDefinition' || member.type === 'TSMethodSignature') {
        // Note: TSMethodSignature usually doesn't have a body, so we skip call extraction
        // But MethodDefinition does.
        const methodName = member.key?.name;
        if (!methodName) continue;

        const startLine = member.loc?.start.line ?? 0;
        const endLine = member.loc?.end.line ?? 0;
        
        // Extract parameters
        const params: string[] = [];
        if (member.value?.params) {
          for (const p of member.value.params) {
            if (p.type === 'Identifier') params.push(p.name);
            else if (p.type === 'AssignmentPattern' && p.left?.type === 'Identifier') params.push(p.left.name);
          }
        }

        methods.push({
          name: methodName,
          className,
          startLine,
          endLine,
          parameters: params,
        });

        if (member.value?.body) {
          this.extractCallSites(member.value.body, methodName, 'method', callSites);
        }
      }
    }
  }

  /**
   * Recursively walk a function body to find CallExpressions.
   */
  private extractCallSites(
    bodyNode: any,
    callerName: string,
    callerKind: 'function' | 'method',
    callSites: CallSiteInfo[],
  ): void {
    if (!bodyNode) return;

    // Simple recursive walker
    const visit = (node: any) => {
      if (!node) return;

      if (node.type === 'CallExpression') {
        this.processCallExpression(node, callerName, callerKind, callSites);
      }

      // Traverse children
      for (const key of Object.keys(node)) {
        if (key === 'parent' || key === 'loc' || key === 'range') continue;
        const child = node[key];
        if (Array.isArray(child)) {
          child.forEach(c => visit(c));
        } else if (typeof child === 'object' && child !== null) {
          visit(child);
        }
      }
    };

    visit(bodyNode);
  }

  private processCallExpression(
    node: any,
    callerName: string,
    callerKind: 'function' | 'method',
    callSites: CallSiteInfo[],
  ): void {
    let calleeName = '';
    let calleeQualified = '';

    const callee = node.callee;
    if (callee.type === 'Identifier') {
      calleeName = callee.name;
      calleeQualified = callee.name;
    } else if (callee.type === 'MemberExpression') {
      // e.g. this.service.method() or object.method()
      const property = callee.property?.name;
      let objectName = '';
      
      if (callee.object?.type === 'Identifier') {
        objectName = callee.object.name;
      } else if (callee.object?.type === 'ThisExpression') {
        objectName = 'this';
      } else if (callee.object?.type === 'MemberExpression') {
         // deeply nested: this.foo.bar.baz() - simplify to just taking the last part
         // For now, we just try to grab the property name
         // A full qualified name reconstruction would be complex
         objectName = '...';
      }

      if (property) {
        calleeName = property;
        calleeQualified = objectName ? `${objectName}.${property}` : property;
      }
    }

    if (calleeName) {
      callSites.push({
        callerName,
        callerKind,
        calleeName,
        calleeQualified,
        line: node.loc?.start.line ?? 0,
      });
    }
  }

  private processImport(node: any, imports: ImportInfo[]): void {
    const source: string = node.source?.value ?? '';
    const names: string[] = [];

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type === 'ImportDefaultSpecifier') {
        names.push(specifier.local?.name ?? 'default');
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        names.push(`* as ${specifier.local?.name ?? ''}`);
      } else if (specifier.type === 'ImportSpecifier') {
        names.push(specifier.imported?.name ?? specifier.local?.name ?? '');
      }
    }

    imports.push({
      source,
      names: names.filter(Boolean),
      isRelative: source.startsWith('.'),
    });
  }

  /** Extract decorator names from a node's decorators array */
  private extractDecorators(node: any): string[] {
    const decorators: string[] = [];
    for (const dec of node.decorators ?? []) {
      const expr = dec.expression;
      if (!expr) continue;
      if (expr.type === 'Identifier') {
        decorators.push(expr.name);
      } else if (expr.type === 'CallExpression') {
        const callee = expr.callee;
        if (callee?.type === 'Identifier') {
          decorators.push(callee.name);
        } else if (callee?.type === 'MemberExpression') {
          // e.g. SomeModule.Controller
          decorators.push((callee as any).property?.name ?? '');
        }
      }
    }
    return decorators.filter(Boolean);
  }

  /** Check if a node is a top-level exported declaration */
  private isExported(): boolean {
    // Exported declarations have parent ExportNamedDeclaration — but since we
    // check the raw node (not wrapped), look for 'export' keyword flag on VariableDeclaration
    // For ClassDeclaration / FunctionDeclaration there's no direct flag at the node level
    // when processed from ExportNamedDeclaration.declaration — we call processExportedDeclaration
    // So this function is used when the node is processed directly from body:
    return false; // Direct body nodes are not exported (exported ones are inside ExportNamedDeclaration)
  }

  /**
   * Detect NestJS role of a file based on path and decorator patterns.
   * Priority: path-based first, then decorator-based.
   */
  detectNestRole(symbols: SymbolInfo[], filePath: string): NestRole {
    if (filePath.endsWith('.entity.ts')) return 'entity';
    if (filePath.endsWith('.dto.ts')) return 'dto';
    if (filePath.endsWith('.guard.ts')) return 'guard';
    if (filePath.endsWith('.interceptor.ts')) return 'interceptor';
    if (filePath.endsWith('.filter.ts')) return 'filter';
    if (filePath.endsWith('.pipe.ts')) return 'pipe';
    if (filePath.endsWith('.middleware.ts')) return 'middleware';
    if (filePath.endsWith('.strategy.ts')) return 'strategy';
    if (filePath.endsWith('.decorator.ts')) return 'decorator';

    // Decorator-based detection
    const hasDecorator = (name: string) =>
      symbols.some((s) => s.decorators.includes(name));

    if (hasDecorator('Controller')) return 'controller';
    if (hasDecorator('Injectable') && filePath.includes('service')) return 'service';
    if (hasDecorator('Module')) return 'module';
    if (hasDecorator('Injectable')) return 'service'; // fallback

    return 'unknown';
  }

  /**
   * Return symbols whose lineStart falls within the given line range (inclusive).
   */
  getChunkSymbols(fileStructure: FileStructure, lineStart: number, lineEnd: number): SymbolInfo[] {
    return fileStructure.symbols.filter(
      (sym) => sym.lineStart >= lineStart && sym.lineStart <= lineEnd,
    );
  }

  /**
   * Build an enriched context header for a chunk.
   * Omits Role line if nestRole is 'unknown', omits Symbols line if empty.
   */
  buildEnrichedHeader(
    filePath: string,
    moduleName: string | null,
    lineStart: number,
    lineEnd: number,
    symbols: SymbolInfo[],
    nestRole: NestRole,
  ): string {
    let header = `// File: ${filePath}\n`;
    if (moduleName) {
      header += `// Module: ${moduleName}\n`;
    }
    if (nestRole && nestRole !== 'unknown') {
      header += `// Role: ${nestRole}\n`;
    }
    if (symbols.length > 0) {
      const symbolStr = symbols
        .map((s) => {
          const decStr = s.decorators.length > 0 ? `, ${s.decorators.map((d) => `@${d}`).join(', ')}` : '';
          return `${s.name} (${s.kind}${decStr})`;
        })
        .join(', ');
      header += `// Symbols: ${symbolStr}\n`;
    }
    header += `// Lines: ${lineStart}-${lineEnd}\n---\n`;
    return header;
  }
}
