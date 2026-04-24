import { Body, Controller, Get, Logger, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { McpService } from './mcp.service';

class ExecuteMcpToolDto {
  @ApiProperty({
    description: 'MCP tool name',
    example: 'search_codebase',
  })
  @IsString()
  tool!: string;

  @ApiPropertyOptional({
    description: 'Tool input arguments',
    example: { query: 'find auth guards' },
  })
  @IsOptional()
  @IsObject()
  args?: Record<string, any>;
}

@ApiTags('mcp')
@ApiBearerAuth()
@Controller('mcp')
@UseGuards(JwtAuthGuard)
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcpService: McpService) {}

  @Get('tools')
  @ApiOperation({ summary: 'List registered MCP tools and parameter schemas' })
  @ApiOkResponse({ description: 'MCP tool catalog' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  tools() {
    return this.mcpService.getToolCatalog();
  }

  @Get('capabilities')
  @ApiOperation({
    summary:
      'Report MCP backend capabilities (version + tool list + feature flags). ' +
      'Consumed by the @coderover/mcp client during the initialize handshake.',
  })
  @ApiOkResponse({
    description: 'Capability envelope',
    schema: {
      example: {
        version: '0.9.1',
        tools: ['search_codebase', 'find_symbol', 'find_dependencies', 'get_file'],
        features: { confidence_tags: false, incremental_cache: false },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  capabilities() {
    return {
      version: this.readProjectVersion(),
      tools: this.mcpService.getTools().map((t) => t.name),
      features: {
        // These flip to `true` as B and C workstreams land in Phase 10.
        // Keep both flags here so clients can do a capability check today.
        confidence_tags: false,
        incremental_cache: false,
      },
    };
  }

  /** Read the top-level VERSION file. Falls back to package.json, then '0.0.0'. */
  private readProjectVersion(): string {
    const candidates = [
      path.resolve(process.cwd(), 'VERSION'),
      path.resolve(__dirname, '../../../VERSION'),
      path.resolve(__dirname, '../../../../VERSION'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const v = fs.readFileSync(p, 'utf8').trim();
          if (v) return v;
        }
      } catch {
        // keep trying
      }
    }
    try {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (typeof pkg.version === 'string') return pkg.version;
      }
    } catch {
      // fall through
    }
    return '0.0.0';
  }

  @Get('history')
  @ApiOperation({ summary: 'List recent MCP tool executions' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiOkResponse({ description: 'MCP execution history entries' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  history(@Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    return this.mcpService.getExecutionHistory(limit ?? 20);
  }

  @Post('execute')
  @ApiOperation({ summary: 'Execute one MCP tool call via REST' })
  @ApiBody({
    type: ExecuteMcpToolDto,
    examples: {
      search: {
        summary: 'Run search_codebase tool',
        value: { tool: 'search_codebase', args: { query: 'jwt guard usage' } },
      },
    },
  })
  @ApiOkResponse({
    description: 'Tool execution result envelope',
    schema: {
      example: {
        tool: 'search_codebase',
        args: { query: 'jwt guard usage' },
        ok: true,
        error: null,
        durationMs: 212,
        results: [],
        result: { matches: [] },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async execute(@Body() dto: ExecuteMcpToolDto) {
    const tool = dto.tool;
    const args = dto.args ?? {};

    this.logger.log(`MCP execute: ${tool}`);

    const call = await this.mcpService.executeTool(tool, args);
    const result = call.result ?? null;
    const results = Array.isArray((result as any)?.results) ? (result as any).results : [];

    return {
      tool: call.toolName,
      args: call.args,
      ok: !call.error,
      error: call.error ?? null,
      durationMs: call.durationMs,
      results,
      result,
    };
  }
}
