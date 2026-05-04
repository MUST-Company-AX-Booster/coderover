import { Injectable, Logger } from '@nestjs/common';
import { AstService, SymbolInfo, NestRole, ImportInfo, MethodInfo, CallSiteInfo, InheritanceInfo } from './ast.service';
import { countCredentialMatches, redactCredentials } from './credential-redactor.service';
import { MultiLangAstService } from './languages/multi-lang-ast.service';
import { LanguageDetectorService, SupportedLanguage, SupportedFramework } from './languages/language-detector.service';

export interface ChunkResult {
  chunkText: string;
  rawText: string;
  filePath: string;
  moduleName: string | null;
  lineStart: number;
  lineEnd: number;
  commitSha: string;
  symbols: SymbolInfo[];
  nestRole: NestRole;
  imports: ImportInfo[];
  exports: string[];
  language: SupportedLanguage;
  framework: SupportedFramework | null;
  // Entity-level graph data (usually attached to the first chunk of the file or distributed)
  // For simplicity, we attach all file-level entities to the first chunk, or duplicate them?
  // Actually, methods/calls are line-specific.
  // We should probably filter them per chunk like symbols.
  // But the requirement says "upsert to code_methods table".
  // EmbedderService persists them separately from chunks.
  // So we can attach the FULL list to the first chunk, or just pass them along with every chunk?
  // Better: Attach ALL of them to every chunk (wasteful) OR just the first one?
  // Actually, embedder.service checks "if methods.length > 0".
  // If we split them by line, we get precise mapping.
  // Let's try to filter them by line if possible, or just attach the whole set to the result 
  // and let embedder handle deduplication (it uses unique constraints? No, insert loop).
  // Wait, the new tables code_methods/calls don't have unique constraints in the migration I wrote.
  // They have ID PK. So duplicate inserts = duplicate rows.
  // We must ensure we only insert ONCE per file.
  // So, we should attach them ONLY to the first chunk of the file.
  methods?: MethodInfo[];
  callSites?: CallSiteInfo[];
  inheritance?: InheritanceInfo[];
}

export interface FileToChunk {
  filePath: string;
  content: string;
  commitSha: string;
  framework?: SupportedFramework;
}

/** Patterns that indicate a good place to split code */
const BOUNDARY_PATTERNS = [
  /^@Injectable\(\)/,
  /^@Controller\(/,
  /^@Module\(/,
  /^export\s+class\s+/,
  /^export\s+function\s+/,
  /^export\s+const\s+/,
  /^export\s+interface\s+/,
  /^export\s+type\s+/,
  /^export\s+enum\s+/,
  /^export\s+abstract\s+class\s+/,
  /^\s*(async\s+)?(private|public|protected)\s+\w+\s*\(/,
  /^\s*async\s+\w+\s*\(/,
  /^def\s+/,          // Python functions
  /^class\s+/,        // Python/Ruby classes
  /^func\s+/,         // Go functions
  /^fn\s+/,           // Rust functions
  /^pub\s+fn\s+/,     // Rust public functions
  /^pub(\([\w:]+\))?\s+fn\s+/,              // Rust pub(crate), pub(super), etc.
  /^impl\s+/,                                // Rust impl blocks
  /^pub\s+(struct|enum|trait|type|mod|const|static)\s+/, // Rust pub items
  /^(struct|enum|trait|type|mod|const|static)\s+/,       // Rust private items
  /^public\s+(class|interface|enum|static)/, // Java
  /^fun\s+/,          // Kotlin functions
  /^(internal|private|public|protected)\s+fun\s+/, // Kotlin visibility + fun
  /^(object|interface|sealed|data|enum|abstract)\s+class\s+/, // Kotlin class variants
  /^class\s+\w+/,     // Kotlin/Ruby/Python classes (already above for Python; harmless dup)
  /^(public|internal|private)\s+(class|object|interface)\s+/, // Kotlin top-level decls
  /^func\s+\w+\s*\(/, // Swift functions
  /^(struct|extension|protocol)\s+\w+/,      // Swift top-level
];

/** File extensions/paths excluded from indexing */
const EXCLUDED_EXTENSIONS = [
  '.spec.ts', '.test.ts', '.e2e-spec.ts',
  '.json', '.lock', '.env',
  '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip',
  '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot',
];

const EXCLUDED_PATHS = ['node_modules/', 'dist/', '.git/', '/migrations/'];

/** Extensions that ARE indexable (source code + docs + configs) */
const INDEXABLE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.kt', '.kts', '.rs', '.swift', '.php',
  '.vue', '.svelte',
  '.md', '.mdx',
  '.yml', '.yaml',
  '.sql', '.prisma',
  '.graphql', '.gql',
  '.proto',
  '.tf', '.tfvars',
];

/** Target chunk size in characters (~500 tokens * 4 chars/token) */
const TARGET_CHUNK_SIZE = 2000;

/** Overlap between consecutive chunks in characters */
const OVERLAP_SIZE = 200;

@Injectable()
export class ChunkerService {
  private readonly logger = new Logger(ChunkerService.name);

  constructor(
    private readonly astService: AstService,
    private readonly multiLangAstService: MultiLangAstService,
    private readonly languageDetector: LanguageDetectorService,
  ) {}

  /**
   * Determine if a file should be indexed based on its path.
   */
  shouldIndex(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    const pathParts = lower.split('/');

    if (pathParts.some((p) => p.startsWith('.') && p.length > 1)) return false;
    if (pathParts[pathParts.length - 1]?.startsWith('.env')) return false;

    for (const excluded of EXCLUDED_PATHS) {
      if (lower.includes(excluded.toLowerCase())) return false;
    }

    for (const ext of EXCLUDED_EXTENSIONS) {
      if (lower.endsWith(ext)) return false;
    }

    // Must match at least one indexable extension
    return INDEXABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  /**
   * Derive the module name from a file path.
   * src/booking/booking.service.ts -> BookingModule
   */
  deriveModuleName(filePath: string): string | null {
    const match = filePath.match(/^src\/([^/]+)\//);
    if (!match) return null;
    const name = match[1];
    return name.charAt(0).toUpperCase() + name.slice(1) + 'Module';
  }

  /**
   * Split a source file into overlapping chunks with context headers and line tracking.
   * Uses smart boundary detection to avoid splitting mid-function.
   * Handles TypeScript (via ESTree) and all other languages (via tree-sitter).
   */
  chunkFile(file: FileToChunk): ChunkResult[] {
    if (!this.shouldIndex(file.filePath)) return [];

    const { content, filePath, commitSha } = file;
    if (content.includes('\u0000')) return [];
    if (!content || content.trim().length === 0) return [];

    const moduleName = this.deriveModuleName(filePath);
    const language = this.languageDetector.detectLanguage(filePath);
    const framework = file.framework ?? null;
    const lines = content.split('\n');
    const chunks: ChunkResult[] = [];

    // Choose parser based on language
    const isTypeScript = language === 'typescript';
    const fileStructure = isTypeScript
      ? this.astService.parseFile(filePath, content)
      : this.multiLangAstService.parseFile(filePath, content, language);

    // Determine nestRole
    let nestRole: NestRole = 'unknown';
    if (isTypeScript) {
      nestRole = (fileStructure as any).nestRole ?? 'unknown';
    } else if (framework) {
      const role = this.languageDetector.getFrameworkRole(filePath, framework);
      nestRole = (role as NestRole) ?? 'unknown';
    }

    let currentStart = 0;

    while (currentStart < lines.length) {
      const { endLine } = this.findChunkBoundary(lines, currentStart);
      const chunkLines = lines.slice(currentStart, endLine + 1);
      const rawText = chunkLines.join('\n');

      if (rawText.trim().length > 0) {
        // For TypeScript, use the enriched header from AstService
        let chunkSymbols: SymbolInfo[] = [];
        let chunkText = rawText;

        if (isTypeScript) {
          const tsStructure = fileStructure as ReturnType<AstService['parseFile']>;
          chunkSymbols = this.astService.getChunkSymbols(
            tsStructure,
            currentStart + 1,
            endLine + 1,
          );
          const header = this.astService.buildEnrichedHeader(
            filePath,
            moduleName,
            currentStart + 1,
            endLine + 1,
            chunkSymbols,
            tsStructure.nestRole,
          );
          chunkText = header + rawText;
        } else {
          // For other languages, build a lightweight header
          const mlStructure = fileStructure as ReturnType<MultiLangAstService['parseFile']>;
          chunkSymbols = mlStructure.symbols.filter(
            (s) => s.lineStart >= currentStart + 1 && s.lineStart <= endLine + 1,
          );
          const header = this.buildMultiLangHeader(
            filePath, moduleName, currentStart + 1, endLine + 1,
            chunkSymbols, language, nestRole,
          );
          chunkText = header + rawText;
        }

        const structure = fileStructure as any;

        // Attach entity graph data only to the first chunk to avoid duplicates in DB
        // (Since EmbedderService inserts them into separate tables)
        const isFirstChunk = currentStart === 0;
        
        // Phase 3C (Zero Trust): scrub high-confidence credential
        // patterns before the chunk reaches the embedder. A committed
        // AWS key or GitHub PAT in source would otherwise land in
        // pgvector and the LLM provider's logs.
        chunks.push({
          chunkText: redactCredentials(chunkText),
          rawText: redactCredentials(rawText),
          filePath,
          moduleName,
          lineStart: currentStart + 1,
          lineEnd: endLine + 1,
          commitSha,
          symbols: chunkSymbols,
          nestRole,
          imports: structure.imports ?? [],
          exports: structure.exports ?? [],
          language,
          framework,
          methods: isFirstChunk ? (structure.methods ?? []) : [],
          callSites: isFirstChunk ? (structure.callSites ?? []) : [],
          inheritance: isFirstChunk ? (structure.inheritance ?? []) : [],
        });
      }

      const overlapLines = this.charsToLineCount(lines, endLine, OVERLAP_SIZE);
      const nextStart = endLine + 1 - overlapLines;
      currentStart = nextStart <= currentStart ? endLine + 1 : nextStart;
    }

    // Per-file telemetry on credential redactions — useful when reading
    // ingestion logs to spot a repo that's spraying secrets in source.
    const fileLevelMatches = countCredentialMatches(content);
    const totalRedacted = Object.values(fileLevelMatches).reduce((a, b) => a + b, 0);
    if (totalRedacted > 0) {
      this.logger.warn(
        `Redacted ${totalRedacted} credential pattern(s) from ${filePath}: ${Object.entries(fileLevelMatches)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
      );
    }

    this.logger.debug(`Chunked ${filePath} (${language}): ${chunks.length} chunks from ${lines.length} lines`);
    return chunks;
  }

  private buildMultiLangHeader(
    filePath: string,
    moduleName: string | null,
    lineStart: number,
    lineEnd: number,
    symbols: SymbolInfo[],
    language: string,
    nestRole: string,
  ): string {
    const parts: string[] = [
      `// File: ${filePath}`,
      `// Language: ${language}`,
    ];
    if (moduleName) parts.push(`// Module: ${moduleName}`);
    if (nestRole && nestRole !== 'unknown') parts.push(`// Role: ${nestRole}`);
    parts.push(`// Lines: ${lineStart}-${lineEnd}`);

    if (symbols.length > 0) {
      const symbolNames = symbols.map((s) => `${s.name}(${s.kind})`).join(', ');
      parts.push(`// Symbols: ${symbolNames}`);
    }

    return parts.join('\n') + '\n\n';
  }

  private findChunkBoundary(lines: string[], startLine: number): { endLine: number } {
    let charCount = 0;
    let lastBoundary = -1;
    let endLine = startLine;

    for (let i = startLine; i < lines.length; i++) {
      charCount += lines[i].length + 1;

      if (i > startLine && this.isBoundaryLine(lines[i])) {
        if (charCount >= TARGET_CHUNK_SIZE * 0.6) return { endLine: i - 1 };
        lastBoundary = i - 1;
      }

      if (charCount >= TARGET_CHUNK_SIZE) {
        if (lastBoundary > startLine) return { endLine: lastBoundary };
        return { endLine: i };
      }

      endLine = i;
    }

    return { endLine };
  }

  private isBoundaryLine(line: string): boolean {
    const trimmed = line.trimStart();
    return BOUNDARY_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  private charsToLineCount(lines: string[], endLine: number, charTarget: number): number {
    let charCount = 0;
    let lineCount = 0;
    for (let i = endLine; i >= 0 && charCount < charTarget; i--) {
      charCount += lines[i].length + 1;
      lineCount++;
    }
    return Math.max(lineCount - 1, 0);
  }
}
