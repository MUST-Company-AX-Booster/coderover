export type PluginType = 'mcp-tool' | 'ast-parser';

export interface PluginManifest {
  name: string;
  version: string;
  type: PluginType;
  entry?: string;
  permissions?: Array<'read:repo' | 'read:graph' | 'read:artifacts'>;
  configSchema?: Record<string, unknown>;
}
