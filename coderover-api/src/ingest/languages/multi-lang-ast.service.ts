import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SymbolInfo, ImportInfo, MethodInfo, CallSiteInfo, InheritanceInfo } from '../ast.service';
import { SupportedLanguage } from './language-detector.service';

export interface MultiLangFileStructure {
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: string[];
  language: SupportedLanguage;
  parseError: boolean;
  
  // Entity-level graph data
  methods: MethodInfo[];
  callSites: CallSiteInfo[];
  inheritance: InheritanceInfo[];
}

/**
 * Multi-language AST parser using tree-sitter.
 * Handles: Python, Go, Java, Kotlin, Rust, PHP, JavaScript, Vue SFC.
 * TypeScript/TSX is still handled by the existing AstService.
 */
@Injectable()
export class MultiLangAstService implements OnModuleInit {
  private readonly logger = new Logger(MultiLangAstService.name);

  private parsers = new Map<SupportedLanguage, any>();

  async onModuleInit(): Promise<void> {
    await this.initParsers();
  }

  private async initParsers(): Promise<void> {
    let ParserCtor: any;
    try {
      const parserModule: any = await import('tree-sitter');
      ParserCtor = parserModule?.default ?? parserModule;
    } catch (err) {
      this.logger.warn(`Failed to load tree-sitter: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const grammars: Array<[SupportedLanguage, () => Promise<any>]> = [
      ['python', async () => {
        const mod: any = await import('tree-sitter-python');
        return mod?.default ?? mod;
      }],
      ['go', async () => {
        const mod: any = await import('tree-sitter-go');
        return mod?.default ?? mod;
      }],
      ['java', async () => {
        const mod: any = await import('tree-sitter-java');
        return mod?.default ?? mod;
      }],
      ['kotlin', async () => {
        const mod: any = await import('tree-sitter-kotlin');
        return mod?.default ?? mod;
      }],
      ['rust', async () => {
        const mod: any = await import('tree-sitter-rust');
        return mod?.default ?? mod;
      }],
      ['php', async () => {
        const mod: any = await import('tree-sitter-php');
        const resolved = mod?.default ?? mod;
        return resolved?.php ?? resolved;
      }],
      ['javascript', async () => {
        const mod: any = await import('tree-sitter-javascript');
        return mod?.default ?? mod;
      }],
    ];

    for (const [lang, loadLanguage] of grammars) {
      try {
        const languageObject = await loadLanguage();
        const parser = new ParserCtor();
        parser.setLanguage(languageObject);
        this.parsers.set(lang, parser);
        this.logger.log(`Loaded tree-sitter grammar for ${lang}`);
      } catch (err) {
        this.logger.warn(
          `Failed to load tree-sitter grammar for ${lang}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Parse a file using tree-sitter and extract symbols/imports.
   * Falls back to empty structure on parse error.
   */
  parseFile(filePath: string, content: string, language: SupportedLanguage): MultiLangFileStructure {
    // Vue SFC: extract <script> block and parse as JS/TS
    if (language === 'vue') {
      return this.parseVueSfc(filePath, content);
    }

    const parser = this.parsers.get(language);
    if (!parser) {
      return { 
        symbols: [], imports: [], exports: [], language, parseError: false,
        methods: [], callSites: [], inheritance: [] 
      };
    }

    try {
      const tree = parser.parse(content);
      return this.extractStructure(tree.rootNode, language, content);
    } catch (err) {
      console.error(`Error in parseFile for ${language}:`, err);
      this.logger.debug(
        `tree-sitter parse error for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { 
        symbols: [], imports: [], exports: [], language, parseError: true,
        methods: [], callSites: [], inheritance: [] 
      };
    }
  }

  private parseVueSfc(filePath: string, content: string): MultiLangFileStructure {
    // Extract <script setup lang="ts"> or <script> block
    const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (!scriptMatch) {
      return { 
        symbols: [], imports: [], exports: [], language: 'vue', parseError: false,
        methods: [], callSites: [], inheritance: [] 
      };
    }

    const scriptContent = scriptMatch[1];
    const isTs = /<script[^>]*lang=["']ts["'][^>]*>/i.test(content);
    const scriptLang: SupportedLanguage = isTs ? 'typescript' : 'javascript';

    // For TS scripts in Vue, fall back to the outer AstService (TypeScript-ESTree)
    // For JS scripts, use tree-sitter JavaScript
    if (scriptLang === 'typescript') {
      // Minimal extraction — the outer ast.service will handle TS files
      return { 
        symbols: [], imports: [], exports: [], language: 'vue', parseError: false,
        methods: [], callSites: [], inheritance: [] 
      };
    }

    const parser = this.parsers.get('javascript');
    if (!parser) {
      return { 
        symbols: [], imports: [], exports: [], language: 'vue', parseError: false,
        methods: [], callSites: [], inheritance: [] 
      };
    }

    try {
      const tree = parser.parse(scriptContent);
      const result = this.extractStructure(tree.rootNode, 'javascript', scriptContent);
      return { ...result, language: 'vue' };
    } catch {
      return { 
        symbols: [], imports: [], exports: [], language: 'vue', parseError: true,
        methods: [], callSites: [], inheritance: [] 
      };
    }
  }

  private extractStructure(
    rootNode: any,
    language: SupportedLanguage,
    content: string,
  ): MultiLangFileStructure {
    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: string[] = [];
    const methods: MethodInfo[] = [];
    const callSites: CallSiteInfo[] = [];
    const inheritance: InheritanceInfo[] = [];

    switch (language) {
      case 'python':
        this.extractPython(rootNode, content, symbols, imports, methods, callSites, inheritance);
        break;
      case 'go':
        this.extractGo(rootNode, content, symbols, imports, methods, callSites);
        break;
      case 'java':
        this.extractJava(rootNode, content, symbols, methods, callSites);
        break;
      case 'kotlin':
        this.extractKotlin(rootNode, content, symbols, imports);
        break;
      case 'rust':
        this.extractRust(rootNode, content, symbols, methods, callSites);
        break;
      case 'php':
        this.extractPhp(rootNode, content, symbols, imports);
        break;
      case 'javascript':
        this.extractJavaScript(rootNode, content, symbols, imports, exports);
        break;
    }

    return { symbols, imports, exports, language, parseError: false, methods, callSites, inheritance };
  }

  // ── Language-specific extractors ─────────────────────────────────────────

  private extractPython(
    root: any, 
    content: string, 
    symbols: SymbolInfo[], 
    imports: ImportInfo[],
    methods: MethodInfo[],
    callSites: CallSiteInfo[],
    inheritance: InheritanceInfo[]
  ): void {
    this.walkTree(root, (node: any) => {
      if (node.type === 'function_definition' || node.type === 'async_function_definition') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'identifier');
        if (nameNode) {
          const name = this.nodeText(nameNode, content);
          const decorators = this.collectDecorators(node, content);
          symbols.push({
            name,
            kind: 'function',
            exported: !name.startsWith('_'),
            decorators,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });

          // Extract calls inside function
          this.extractPythonCalls(node.childForFieldName?.('body'), name, 'function', content, callSites);
        }
      }

      if (node.type === 'class_definition') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'identifier');
        if (nameNode) {
          const className = this.nodeText(nameNode, content);
          const decorators = this.collectDecorators(node, content);
          symbols.push({
            name: className,
            kind: 'class',
            exported: !className.startsWith('_'),
            decorators,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });

          // Inheritance
          const superClasses = node.childForFieldName?.('superclasses');
          if (superClasses) {
             const bases: string[] = [];
             this.walkTree(superClasses, (child) => {
               if (child.type === 'identifier' || child.type === 'attribute') {
                 bases.push(this.nodeText(child, content));
               }
             }, 1);
             if (bases.length > 0) {
               inheritance.push({
                 className,
                 extends: bases[0], // Python supports multiple, but we simplify to first for now or store all in implements
                 implements: bases.slice(1),
               });
             }
          }

          // Extract methods
          this.walkTree(node.childForFieldName?.('body'), (child) => {
            if (child.type === 'function_definition' || child.type === 'async_function_definition') {
              const methodNameNode = child.childForFieldName?.('name') ?? this.findChild(child, 'identifier');
              if (methodNameNode) {
                const methodName = this.nodeText(methodNameNode, content);
                
                // Extract params
                const params: string[] = [];
                const paramsNode = child.childForFieldName?.('parameters');
                if (paramsNode) {
                  this.walkTree(paramsNode, (p) => {
                    if (p.type === 'identifier') params.push(this.nodeText(p, content));
                  }, 1);
                }

                methods.push({
                  name: methodName,
                  className,
                  startLine: child.startPosition.row + 1,
                  endLine: child.endPosition.row + 1,
                  parameters: params
                });

                // Extract calls inside method
                this.extractPythonCalls(child.childForFieldName?.('body'), methodName, 'method', content, callSites);
              }
            }
          }, 1);
        }
      }

      if (node.type === 'import_statement' || node.type === 'import_from_statement') {
        const names: string[] = [];
        this.walkTree(node, (child: any) => {
          if (child.type === 'dotted_name' || child.type === 'identifier') {
            names.push(this.nodeText(child, content));
          }
        });
        const source = node.type === 'import_from_statement'
          ? (this.findChild(node, 'dotted_name')
              ? this.nodeText(this.findChild(node, 'dotted_name'), content)
              : '')
          : names[0] ?? '';
        imports.push({ source, names, isRelative: source.startsWith('.') });
      }
    });
  }

  private extractPythonCalls(
    bodyNode: any,
    callerName: string,
    callerKind: 'function' | 'method',
    content: string,
    callSites: CallSiteInfo[]
  ): void {
    if (!bodyNode) return;
    
    this.walkTree(bodyNode, (node) => {
      if (node.type === 'call') {
        const functionNode = node.childForFieldName?.('function');
        if (functionNode) {
          let calleeName = '';
          let calleeQualified = '';
          
          if (functionNode.type === 'identifier') {
            calleeName = this.nodeText(functionNode, content);
            calleeQualified = calleeName;
          } else if (functionNode.type === 'attribute') {
            const objectNode = functionNode.childForFieldName?.('object');
            const attributeNode = functionNode.childForFieldName?.('attribute');
            if (attributeNode) {
               calleeName = this.nodeText(attributeNode, content);
               if (objectNode) {
                 calleeQualified = `${this.nodeText(objectNode, content)}.${calleeName}`;
               } else {
                 calleeQualified = calleeName;
               }
            }
          }
          
          if (calleeName) {
            callSites.push({
              callerName,
              callerKind,
              calleeName,
              calleeQualified,
              line: node.startPosition.row + 1
            });
          }
        }
      }
    });
  }

  private extractGo(
    root: any, 
    content: string, 
    symbols: SymbolInfo[], 
    imports: ImportInfo[],
    methods: MethodInfo[],
    callSites: CallSiteInfo[]
  ): void {
    this.walkTree(root, (node: any) => {
      if (node.type === 'function_declaration' || node.type === 'method_declaration') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChildByField(node, 'name');
        if (nameNode) {
          const name = this.nodeText(nameNode, content);
          symbols.push({
            name,
            kind: 'function',
            exported: /^[A-Z]/.test(name),
            decorators: [],
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });

          // Extract methods
          let className = '';
          if (node.type === 'method_declaration') {
            className = this.extractGoReceiverType(node, content);
          }

          methods.push({
            name,
            className, // Empty string for standalone functions
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            parameters: this.extractGoParameters(node, content)
          });

          // Extract calls inside body
          const bodyNode = node.childForFieldName?.('body');
          if (bodyNode) {
            this.walkTree(bodyNode, (child) => {
              if (child.type === 'call_expression') {
                const functionNode = child.childForFieldName?.('function');
                if (functionNode) {
                  let calleeName = '';
                  let calleeQualified = '';
                  
                  if (functionNode.type === 'identifier') {
                    calleeName = this.nodeText(functionNode, content);
                    calleeQualified = calleeName;
                  } else if (functionNode.type === 'selector_expression') {
                    const operand = functionNode.childForFieldName?.('operand');
                    const field = functionNode.childForFieldName?.('field');
                    if (field) {
                      calleeName = this.nodeText(field, content);
                      if (operand) {
                        calleeQualified = `${this.nodeText(operand, content)}.${calleeName}`;
                      } else {
                        calleeQualified = calleeName;
                      }
                    }
                  }

                  if (calleeName) {
                    callSites.push({
                      callerName: name,
                      callerKind: className ? 'method' : 'function',
                      calleeName,
                      calleeQualified,
                      line: child.startPosition.row + 1
                    });
                  }
                }
              }
            });
          }
        }
      }

      if (node.type === 'type_declaration') {
        this.walkTree(node, (child: any) => {
          if (child.type === 'type_spec') {
            const nameNode = child.childForFieldName?.('name') ?? this.findChild(child, 'type_identifier');
            if (nameNode) {
              const name = this.nodeText(nameNode, content);
              const isInterface = child.children?.some((c: any) => c.type === 'interface_type');
              symbols.push({
                name,
                kind: isInterface ? 'interface' : 'type',
                exported: /^[A-Z]/.test(name),
                decorators: [],
                lineStart: child.startPosition.row + 1,
                lineEnd: child.endPosition.row + 1,
              });
            }
          }
        }, 1);
      }

      if (node.type === 'import_declaration') {
        this.walkTree(node, (child: any) => {
          if (child.type === 'import_spec') {
            const path = child.childForFieldName?.('path') ?? this.findChild(child, 'interpreted_string_literal');
            if (path) {
              const src = this.nodeText(path, content).replace(/"/g, '');
              imports.push({ source: src, names: [], isRelative: src.startsWith('.') });
            }
          }
        }, 2);
      }
    }, 2);
  }

  private extractJava(
    root: any, 
    content: string, 
    symbols: SymbolInfo[],
    methods: MethodInfo[],
    callSites: CallSiteInfo[]
  ): void {
    this.walkTree(root, (node: any) => {
      if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'identifier');
        if (nameNode) {
          const name = this.nodeText(nameNode, content);
          const modifiers = this.collectModifiers(node);
          const annotations = this.collectAnnotations(node, content);
          symbols.push({
            name,
            kind: node.type === 'interface_declaration' ? 'interface' : node.type === 'enum_declaration' ? 'enum' : 'class',
            exported: modifiers.includes('public'),
            decorators: annotations,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });
        }
      }

      if (node.type === 'method_declaration') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'identifier');
        if (nameNode) {
          const methodName = this.nodeText(nameNode, content);
          const modifiers = this.collectModifiers(node);
          const annotations = this.collectAnnotations(node, content);
          symbols.push({
            name: methodName,
            kind: 'function',
            exported: modifiers.includes('public'),
            decorators: annotations,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });

          methods.push({
            name: methodName,
            className: this.findEnclosingJavaTypeName(node, content),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            parameters: this.extractJavaParameters(node, content)
          });

          // Extract calls inside body
          const bodyNode = node.childForFieldName?.('body');
          if (bodyNode) {
            this.walkTree(bodyNode, (child) => {
              if (child.type === 'method_invocation') {
                const nameNode = child.childForFieldName?.('name') ?? this.findChild(child, 'identifier');
                const objectNode = child.childForFieldName?.('object');
                
                if (nameNode) {
                  const calleeName = this.nodeText(nameNode, content);
                  let calleeQualified = calleeName;
                  
                  if (objectNode) {
                    calleeQualified = `${this.nodeText(objectNode, content)}.${calleeName}`;
                  }

                  callSites.push({
                    callerName: methodName,
                    callerKind: 'method',
                    calleeName,
                    calleeQualified,
                    line: child.startPosition.row + 1
                  });
                }
              }
            });
          }
        }
      }
    }, 6);
  }

  private extractKotlin(root: any, content: string, symbols: SymbolInfo[], imports: ImportInfo[]): void {
    this.walkTree(root, (node: any) => {
      if (node.type === 'class_declaration' || node.type === 'object_declaration') {
        const nameNode = this.findChild(node, 'type_identifier') ?? this.findChild(node, 'simple_identifier');
        if (nameNode) {
          const annotations = this.collectAnnotations(node, content);
          symbols.push({
            name: this.nodeText(nameNode, content),
            kind: 'class',
            exported: !content.substring(node.startIndex - 10, node.startIndex).includes('private'),
            decorators: annotations,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });
        }
      }

      if (node.type === 'function_declaration') {
        const nameNode = this.findChild(node, 'simple_identifier');
        if (nameNode) {
          symbols.push({
            name: this.nodeText(nameNode, content),
            kind: 'function',
            exported: true,
            decorators: [],
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });
        }
      }

      if (node.type === 'import_header') {
        const src = content.substring(node.startIndex, node.endIndex).replace(/^import\s+/, '').trim();
        imports.push({ source: src, names: [src.split('.').pop() ?? ''], isRelative: false });
      }
    }, 6);
  }

  private extractRust(
    root: any, 
    content: string, 
    symbols: SymbolInfo[],
    methods: MethodInfo[],
    callSites: CallSiteInfo[]
  ): void {
    this.walkTree(root, (node: any) => {
      if (
        node.type === 'function_item' ||
        node.type === 'struct_item' ||
        node.type === 'enum_item' ||
        node.type === 'trait_item' ||
        node.type === 'impl_item'
      ) {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'identifier') ?? this.findChild(node, 'type_identifier');
        if (nameNode) {
          const name = this.nodeText(nameNode, content);
          const kindMap: Record<string, SymbolInfo['kind']> = {
            function_item: 'function',
            struct_item: 'class',
            enum_item: 'enum',
            trait_item: 'interface',
            impl_item: 'class',
          };
          symbols.push({
            name,
            kind: kindMap[node.type] ?? 'function',
            exported: content.substring(node.startIndex, node.startIndex + 10).trim().startsWith('pub'),
            decorators: [],
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });

          if (node.type === 'function_item') {
            const implName = this.findEnclosingRustImplName(node, content);
            const isMethod = !!implName;
            
            methods.push({
              name,
              className: implName,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              parameters: this.extractRustParameters(node, content)
            });

            const bodyNode = node.childForFieldName?.('body') ?? this.findChild(node, 'block');
            if (bodyNode) {
              this.walkTree(bodyNode, (child) => {
                if (child.type === 'call_expression') {
                  const functionNode = child.childForFieldName?.('function');
                  if (functionNode) {
                    let calleeName = '';
                    let calleeQualified = '';
                    
                    if (functionNode.type === 'identifier') {
                      calleeName = this.nodeText(functionNode, content);
                      calleeQualified = calleeName;
                    } else if (functionNode.type === 'field_expression') {
                      const value = functionNode.childForFieldName?.('value');
                      const field = functionNode.childForFieldName?.('field');
                      if (field) {
                        calleeName = this.nodeText(field, content);
                        if (value) {
                          calleeQualified = `${this.nodeText(value, content)}.${calleeName}`;
                        } else {
                          calleeQualified = calleeName;
                        }
                      }
                    }

                    if (calleeName) {
                      callSites.push({
                        callerName: name,
                        callerKind: isMethod ? 'method' : 'function',
                        calleeName,
                        calleeQualified,
                        line: child.startPosition.row + 1
                      });
                    }
                  }
                }
              });
            }
          }
        }
      }
    }, 3);
  }

  private extractPhp(root: any, content: string, symbols: SymbolInfo[], imports: ImportInfo[]): void {
    this.walkTree(root, (node: any) => {
      if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'name');
        if (nameNode) {
          symbols.push({
            name: this.nodeText(nameNode, content),
            kind: node.type === 'interface_declaration' ? 'interface' : 'class',
            exported: true,
            decorators: [],
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });
        }
      }

      if (node.type === 'function_definition' || node.type === 'method_declaration') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'name');
        if (nameNode) {
          symbols.push({
            name: this.nodeText(nameNode, content),
            kind: 'function',
            exported: true,
            decorators: [],
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });
        }
      }

      if (node.type === 'namespace_use_declaration') {
        const src = content.substring(node.startIndex, node.endIndex).replace(/^use\s+/, '').replace(/;$/, '').trim();
        imports.push({ source: src, names: [src.split('\\').pop() ?? ''], isRelative: false });
      }
    }, 8);
  }

  private extractJavaScript(
    root: any,
    content: string,
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    exports: string[],
  ): void {
    this.walkTree(root, (node: any) => {
      if (node.type === 'function_declaration' || node.type === 'function') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'identifier');
        if (nameNode) {
          symbols.push({
            name: this.nodeText(nameNode, content),
            kind: 'function',
            exported: false,
            decorators: [],
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });
        }
      }

      if (node.type === 'class_declaration') {
        const nameNode = node.childForFieldName?.('name') ?? this.findChild(node, 'identifier');
        if (nameNode) {
          symbols.push({
            name: this.nodeText(nameNode, content),
            kind: 'class',
            exported: false,
            decorators: [],
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
          });
        }
      }

      if (node.type === 'import_statement') {
        const source = node.childForFieldName?.('source');
        if (source) {
          const src = this.nodeText(source, content).replace(/['"]/g, '');
          const names: string[] = [];
          this.walkTree(node, (child: any) => {
            if (child.type === 'identifier') names.push(this.nodeText(child, content));
          }, 2);
          imports.push({ source: src, names, isRelative: src.startsWith('.') });
        }
      }

      if (node.type === 'export_statement') {
        this.walkTree(node, (child: any) => {
          if (child.type === 'identifier') exports.push(this.nodeText(child, content));
        }, 2);
      }
    }, 2);
  }

  // ── Tree-sitter helpers ───────────────────────────────────────────────────

  private walkTree(node: any, visitor: (n: any) => void, maxDepth = 10, depth = 0): void {
    if (!node) return;
    if (depth > maxDepth) return;
    visitor(node);
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      this.walkTree(node.child(i), visitor, maxDepth, depth + 1);
    }
  }

  private findChild(node: any, type: string): any {
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      const child = node.child(i);
      if (child?.type === type) return child;
    }
    return null;
  }

  private findChildByField(node: any, field: string): any {
    try {
      return node.childForFieldName?.(field) ?? null;
    } catch {
      return null;
    }
  }

  private nodeText(node: any, content: string): string {
    if (!node) return '';
    if (node.text !== undefined) return node.text;
    try {
      return content.substring(node.startIndex, node.endIndex);
    } catch {
      return '';
    }
  }

  private extractGoParameters(node: any, content: string): string[] {
    const paramsNode = node.childForFieldName?.('parameters') ?? this.findChild(node, 'parameter_list');
    if (!paramsNode) return [];

    const parameters: string[] = [];
    this.walkTree(paramsNode, (child: any) => {
      if (child.type === 'parameter_declaration' || child.type === 'variadic_parameter_declaration') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) {
          const name = this.nodeText(nameNode, content).trim();
          if (name) parameters.push(name);
          return;
        }

        for (let i = 0; i < (child.childCount ?? 0); i++) {
          const part = child.child(i);
          if (part?.type === 'identifier') {
            const name = this.nodeText(part, content).trim();
            if (name) parameters.push(name);
          }
        }
      }
    }, 3);
    return parameters;
  }

  private extractGoReceiverType(node: any, content: string): string {
    const receiverNode = node.childForFieldName?.('receiver');
    if (!receiverNode) return '';

    let receiverType = '';
    this.walkTree(receiverNode, (child: any) => {
      if (child.type === 'type_identifier' || child.type === 'qualified_type') {
        const name = this.nodeText(child, content).trim();
        if (name) {
          receiverType = name;
        }
      }
    }, 5);

    if (!receiverType) return '';
    const normalized = receiverType.replace(/^[*&]+/, '').trim();
    return normalized.split('.').pop() ?? normalized;
  }

  private findEnclosingJavaTypeName(node: any, content: string): string {
    let current = node?.parent;
    while (current) {
      if (
        current.type === 'class_declaration' ||
        current.type === 'interface_declaration' ||
        current.type === 'enum_declaration'
      ) {
        const nameNode = current.childForFieldName?.('name') ?? this.findChild(current, 'identifier');
        return nameNode ? this.nodeText(nameNode, content) : '';
      }
      current = current.parent;
    }
    return '';
  }

  private extractJavaParameters(node: any, content: string): string[] {
    const paramsNode = node.childForFieldName?.('parameters') ?? this.findChild(node, 'formal_parameters');
    if (!paramsNode) return [];

    const parameters: string[] = [];
    this.walkTree(paramsNode, (child: any) => {
      if (child.type === 'formal_parameter' || child.type === 'spread_parameter' || child.type === 'receiver_parameter') {
        const nameNode =
          child.childForFieldName?.('name') ??
          this.findChild(child, 'identifier') ??
          this.findChild(child, 'variable_declarator_id');
        if (nameNode) {
          const name = this.nodeText(nameNode, content).trim();
          if (name) parameters.push(name);
        }
      }
    }, 3);
    return parameters;
  }

  private findEnclosingRustImplName(node: any, content: string): string {
    let current = node?.parent;
    while (current) {
      if (current.type === 'impl_item') {
        const typeNode =
          current.childForFieldName?.('type') ??
          this.findChild(current, 'type_identifier') ??
          this.findChild(current, 'scoped_type_identifier');
        if (typeNode) {
          const rawName = this.nodeText(typeNode, content).trim();
          if (rawName) return rawName.split('<')[0].trim();
        }
      }
      current = current.parent;
    }
    return '';
  }

  private extractRustParameters(node: any, content: string): string[] {
    const paramsNode = node.childForFieldName?.('parameters') ?? this.findChild(node, 'parameters');
    if (!paramsNode) return [];

    const parameters: string[] = [];
    this.walkTree(paramsNode, (child: any) => {
      if (child.type === 'self_parameter') {
        const selfName = this.nodeText(child, content).trim().replace(/^&\s*/, '').replace(/\s+/g, ' ');
        if (selfName) parameters.push(selfName.includes('self') ? 'self' : selfName);
      }

      if (child.type === 'parameter') {
        const patternNode = child.childForFieldName?.('pattern');
        if (patternNode) {
          this.walkTree(patternNode, (patternChild: any) => {
            if (patternChild.type === 'identifier' || patternChild.type === 'self') {
              const name = this.nodeText(patternChild, content).trim();
              if (name && name !== '_') parameters.push(name);
            }
          }, 2);
          return;
        }

        const nameNode = this.findChild(child, 'identifier');
        if (nameNode) {
          const name = this.nodeText(nameNode, content).trim();
          if (name && name !== '_') parameters.push(name);
        }
      }
    }, 4);
    return parameters;
  }

  private collectDecorators(node: any, content: string): string[] {
    const decorators: string[] = [];
    // Python decorators are siblings before the node
    let prev = node.previousNamedSibling;
    while (prev && prev.type === 'decorator') {
      const text = this.nodeText(prev, content).replace('@', '').split('(')[0].trim();
      decorators.unshift(text);
      prev = prev.previousNamedSibling;
    }
    return decorators;
  }

  private collectModifiers(node: any): string[] {
    const modifiers: string[] = [];
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' || child?.type === 'modifier') {
        for (let j = 0; j < (child.childCount ?? 0); j++) {
          modifiers.push(child.child(j)?.type ?? '');
        }
      }
    }
    return modifiers;
  }

  private collectAnnotations(node: any, content: string): string[] {
    const annotations: string[] = [];
    const extract = (n: any) => {
      for (let i = 0; i < (n.childCount ?? 0); i++) {
        const child = n.child(i);
        if (child?.type === 'annotation' || child?.type === 'marker_annotation') {
          const text = this.nodeText(child, content).replace('@', '').split('(')[0].trim();
          if (text) annotations.push(text);
        }
        // Recurse one level into modifiers node
        if (child?.type === 'modifiers') {
          extract(child);
        }
      }
    };
    extract(node);
    return annotations;
  }
}
