import { Injectable, Logger } from '@nestjs/common';
import { MCPTool, ToolCall } from './tools/index';
import { SearchCodebaseTool } from './tools/search-codebase.tool';
import { GetModuleSummaryTool } from './tools/get-module-summary.tool';
import { GetApiEndpointsTool } from './tools/get-api-endpoints.tool';
import { GenerateCodeTool } from './tools/generate-code.tool';
import { FindSymbolTool } from './tools/find-symbol.tool';
import { FindDependenciesTool } from './tools/find-dependencies.tool';
import { ReviewPrTool } from './tools/review-pr.tool';
import { GraphAnalysisTool } from './tools/graph-analysis.tool';
import { QueryCodeGraphTool } from './tools/query-code-graph.tool';
import OpenAI from 'openai';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly toolMap: Map<string, MCPTool>;
  private readonly history: Array<ToolCall & { createdAt: string }> = [];

  constructor(
    private readonly searchCodebaseTool: SearchCodebaseTool,
    private readonly getModuleSummaryTool: GetModuleSummaryTool,
    private readonly getApiEndpointsTool: GetApiEndpointsTool,
    private readonly generateCodeTool: GenerateCodeTool,
    private readonly findSymbolTool: FindSymbolTool,
    private readonly findDependenciesTool: FindDependenciesTool,
    private readonly reviewPrTool: ReviewPrTool,
    private readonly graphAnalysisTool: GraphAnalysisTool,
    private readonly queryCodeGraphTool: QueryCodeGraphTool,
  ) {
    this.toolMap = new Map<string, MCPTool>([
      [this.searchCodebaseTool.name, this.searchCodebaseTool],
      [this.getModuleSummaryTool.name, this.getModuleSummaryTool],
      [this.getApiEndpointsTool.name, this.getApiEndpointsTool],
      [this.generateCodeTool.name, this.generateCodeTool],
      [this.findSymbolTool.name, this.findSymbolTool],
      [this.findDependenciesTool.name, this.findDependenciesTool],
      [this.reviewPrTool.name, this.reviewPrTool],
      [this.graphAnalysisTool.name, this.graphAnalysisTool],
      [this.queryCodeGraphTool.name, this.queryCodeGraphTool],
    ]);
  }

  /** Returns all registered MCP tools */
  getTools(): MCPTool[] {
    return [...this.toolMap.values()];
  }

  getToolCatalog() {
    return this.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  getExecutionHistory(limit = 20) {
    return this.history.slice(0, Math.max(1, Math.min(limit, 100)));
  }

  /** Convert MCP tools to OpenAI function-calling format */
  getToolsForOpenAI(): OpenAI.Chat.ChatCompletionTool[] {
    return this.getTools().map((tool) => {
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const param of tool.parameters) {
        properties[param.name] = {
          type: param.type,
          description: param.description,
        };
        if (param.enum) {
          properties[param.name].enum = param.enum;
        }
        if (param.required) {
          required.push(param.name);
        }
      }

      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties,
            required,
          },
        },
      };
    });
  }

  /**
   * Execute a tool by name with given arguments.
   * Never throws — errors are captured in ToolCall.error.
   */
  async executeTool(toolName: string, args: Record<string, any>): Promise<ToolCall> {
    const startTime = Date.now();

    this.logger.log(`Executing tool: ${toolName} (${JSON.stringify(args)})`);

    const tool = this.toolMap.get(toolName);
    if (!tool) {
      return {
        toolName,
        args,
        error: `Tool "${toolName}" not found`,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const result = await tool.execute(args);
      const durationMs = Date.now() - startTime;
      this.logger.log(`Tool ${toolName} completed in ${durationMs}ms`);
      const call: ToolCall = { toolName, args, result, durationMs };
      this.pushHistory(call);
      return call;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool ${toolName} failed: ${errorMsg}`);
      const call: ToolCall = { toolName, args, error: errorMsg, durationMs };
      this.pushHistory(call);
      return call;
    }
  }

  private pushHistory(call: ToolCall) {
    this.history.unshift({
      ...call,
      createdAt: new Date().toISOString(),
    });
    if (this.history.length > 100) {
      this.history.length = 100;
    }
  }
}
