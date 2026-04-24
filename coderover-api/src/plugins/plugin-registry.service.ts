import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PluginManifest } from './plugin.types';
import { PluginSandbox } from './plugin-sandbox';

/**
 * Phase 9 / Workstream D: Plugin registry.
 *
 * Scans the configured plugin directory at boot and indexes manifests.
 * Full sandboxed execution (node:vm with restricted globals) is a
 * follow-up — this service validates manifests and exposes the list.
 */
@Injectable()
export class PluginRegistryService {
  private readonly logger = new Logger(PluginRegistryService.name);
  private manifests: PluginManifest[] = [];
  private instances = new Map<string, Record<string, unknown>>();
  private readonly sandbox = new PluginSandbox();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const pluginsDir = process.env.CODEROVER_PLUGINS_DIR || path.join(process.cwd(), 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      this.logger.debug(`Plugins dir not present (${pluginsDir}); skipping`);
      return;
    }
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const manifest: PluginManifest = JSON.parse(raw);
        if (this.validate(manifest)) {
          this.manifests.push(manifest);
          const pluginDir = path.join(pluginsDir, entry.name);
          const instance = this.sandbox.load(manifest, pluginDir);
          if (instance) {
            this.instances.set(manifest.name, instance);
            this.logger.log(`Loaded plugin: ${manifest.name}@${manifest.version}`);
          }
        }
      } catch (err) {
        this.logger.warn(`Failed to load plugin ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private validate(m: unknown): m is PluginManifest {
    if (!m || typeof m !== 'object') return false;
    const o = m as any;
    return typeof o.name === 'string' && typeof o.version === 'string' && (o.type === 'mcp-tool' || o.type === 'ast-parser');
  }

  list(): PluginManifest[] {
    return [...this.manifests];
  }

  getInstance(name: string): Record<string, unknown> | undefined {
    return this.instances.get(name);
  }

  /** Invoke a function exported by a loaded plugin (best-effort). */
  invoke(pluginName: string, fnName: string, ...args: unknown[]): unknown {
    const inst = this.instances.get(pluginName);
    if (!inst) throw new Error(`Plugin ${pluginName} not loaded`);
    const fn = inst[fnName];
    if (typeof fn !== 'function') throw new Error(`${pluginName}.${fnName} is not a function`);
    return (fn as (...a: unknown[]) => unknown)(...args);
  }
}
