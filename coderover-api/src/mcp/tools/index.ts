/** MCP Tool interfaces and registry types */

export interface MCPToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  required: boolean;
  enum?: string[];
}

export interface MCPTool {
  name: string;
  description: string;
  parameters: MCPToolParameter[];
  execute(args: Record<string, any>): Promise<any>;
}

export interface ToolCall {
  toolName: string;
  args: Record<string, any>;
  result?: any;
  error?: string;
  durationMs: number;
}

export { FindSymbolTool } from './find-symbol.tool';
export { FindDependenciesTool } from './find-dependencies.tool';
export { GraphAnalysisTool } from './graph-analysis.tool';
