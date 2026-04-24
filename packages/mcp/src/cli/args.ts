/**
 * Hand-rolled argv parser.
 *
 * We specifically do NOT pull in commander/yargs/minimist — keeping deps at
 * zero matters for `npx @coderover/mcp` install time. The grammar is
 * intentionally small:
 *
 *   coderover-mcp <cmd> [positional...] [--flag] [--key=value | --key value]
 *
 * Flags we accept are declared per-command; unknown flags are rejected with
 * a clear error so we never silently swallow typos.
 */

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface FlagSpec {
  /** flag name without leading `--` */
  name: string;
  /** short alias without leading `-`, e.g. 'h' */
  alias?: string;
  /** does this flag take a value? `true` for string-valued. */
  takesValue: boolean;
}

export class ArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgParseError';
  }
}

export function parseArgs(argv: string[], allowed: FlagSpec[]): ParsedArgs {
  // argv expected: process.argv.slice(2)
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  const byName = new Map<string, FlagSpec>();
  const byAlias = new Map<string, FlagSpec>();
  for (const spec of allowed) {
    byName.set(spec.name, spec);
    if (spec.alias) byAlias.set(spec.alias, spec);
  }

  let command = '';
  let i = 0;

  // First non-flag positional is the command, rest are positionals.
  // Flags can appear anywhere.
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok === '--') {
      // Everything after is positional.
      i++;
      while (i < argv.length) positional.push(argv[i++]!);
      break;
    }

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
      const spec = byName.get(name);
      if (!spec) {
        // `--help` / `--version` without a registered spec still pass through
        // as boolean flags, but we're strict by default.
        if (name === 'help' || name === 'version') {
          flags[name] = true;
          i++;
          continue;
        }
        throw new ArgParseError(`unknown flag --${name}`);
      }
      if (spec.takesValue) {
        if (inlineVal !== undefined) {
          flags[name] = inlineVal;
          i++;
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            throw new ArgParseError(`--${name} requires a value`);
          }
          flags[name] = next;
          i += 2;
        }
      } else {
        if (inlineVal !== undefined) {
          throw new ArgParseError(`--${name} does not take a value`);
        }
        flags[name] = true;
        i++;
      }
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1) {
      const alias = tok.slice(1);
      const spec = byAlias.get(alias);
      if (!spec) {
        if (alias === 'h') {
          flags.help = true;
          i++;
          continue;
        }
        if (alias === 'V') {
          flags.version = true;
          i++;
          continue;
        }
        throw new ArgParseError(`unknown flag -${alias}`);
      }
      if (spec.takesValue) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new ArgParseError(`-${alias} requires a value`);
        }
        flags[spec.name] = next;
        i += 2;
      } else {
        flags[spec.name] = true;
        i++;
      }
      continue;
    }

    // Positional.
    if (command === '') {
      command = tok;
    } else {
      positional.push(tok);
    }
    i++;
  }

  return { command, positional, flags };
}

/** Cross-command flags understood by the top-level parser. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'help', alias: 'h', takesValue: false },
  { name: 'version', alias: 'V', takesValue: false },
];

/** Flags for `install`. */
export const INSTALL_FLAGS: FlagSpec[] = [
  ...GLOBAL_FLAGS,
  { name: 'remote', takesValue: false },
  { name: 'local', takesValue: false },
  { name: 'api-url', takesValue: true },
  { name: 'token', takesValue: true },
  { name: 'db-path', takesValue: true },
  { name: 'embed', takesValue: true },
  { name: 'dry-run', takesValue: false },
];

/** Flags for `uninstall`. */
export const UNINSTALL_FLAGS: FlagSpec[] = [
  ...GLOBAL_FLAGS,
  { name: 'dry-run', takesValue: false },
];

/** Flags for `doctor`. */
export const DOCTOR_FLAGS: FlagSpec[] = [
  ...GLOBAL_FLAGS,
  { name: 'api-url', takesValue: true },
  { name: 'token', takesValue: true },
];

/** Flags for `upgrade`. */
export const UPGRADE_FLAGS: FlagSpec[] = [
  ...GLOBAL_FLAGS,
  { name: 'api-url', takesValue: true },
  { name: 'token', takesValue: true },
];
