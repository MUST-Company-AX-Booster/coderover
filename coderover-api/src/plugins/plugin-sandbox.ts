import { Logger } from '@nestjs/common';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PluginManifest } from './plugin.types';

/**
 * Phase 9 / Workstream D — Plugin sandbox executor.
 *
 * Loads a plugin's entry file into a fresh VM context, exposing only the
 * host surface the plugin declared via its `permissions` array. Plugins
 * see a curated `host` object, no process / fs / require, no network
 * unless explicitly permitted.
 *
 * Each plugin returns a module.exports object. The registry calls the
 * exposed functions with arguments via a separate vm.runInContext pass.
 *
 * This is intentionally minimal — not a full isolation layer. For
 * untrusted third-party plugins a real isolate (isolated-vm, workerd,
 * WASM) should replace this. Current target is first-party "core"
 * plugins and trusted org-installed plugins.
 */
export interface HostApis {
  log: (msg: unknown) => void;
  readFile?: (p: string) => string;
}

export class PluginSandbox {
  private readonly logger = new Logger(PluginSandbox.name);

  load(manifest: PluginManifest, pluginDir: string): Record<string, unknown> | null {
    const entry = path.join(pluginDir, manifest.entry ?? 'index.js');
    if (!fs.existsSync(entry)) {
      this.logger.warn(`Plugin ${manifest.name}: entry not found at ${entry}`);
      return null;
    }
    const src = fs.readFileSync(entry, 'utf8');
    const exports: Record<string, unknown> = {};
    const moduleObj = { exports };
    const perms = new Set(manifest.permissions ?? []);

    const host: HostApis = {
      log: (msg: unknown) => this.logger.log(`[plugin ${manifest.name}] ${String(msg)}`),
    };
    if (perms.has('read:repo')) {
      host.readFile = (p: string) => {
        // restrict to absolute path inside plugin dir or cwd/repos
        const abs = path.resolve(p);
        if (!abs.startsWith(path.resolve(process.cwd()))) {
          throw new Error('Path outside workspace');
        }
        return fs.readFileSync(abs, 'utf8');
      };
    }

    const sandbox = {
      module: moduleObj,
      exports,
      host,
      console: { log: host.log, warn: host.log, error: host.log },
      setTimeout, clearTimeout,
    };
    try {
      vm.createContext(sandbox);
      vm.runInContext(src, sandbox, { filename: entry, timeout: 1_000 });
    } catch (err) {
      this.logger.warn(`Plugin ${manifest.name} load failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    return moduleObj.exports;
  }
}
