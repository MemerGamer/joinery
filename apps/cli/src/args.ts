/**
 * A small, dependency-free argument parser.
 *
 * Handles long flags (`--file plan.json`, `--file=plan.json`), boolean flags
 * (`--json`), `--` to stop flag parsing, and positional arguments. Unknown
 * flags are a hard error (`UsageError`), never silently ignored.
 */

/** Thrown for a usage mistake. The CLI maps this to exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface FlagSpec {
  readonly name: string;
  readonly type: 'string' | 'boolean';
}

export type FlagValue = string | boolean;

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
}

/**
 * Parses `argv` against `specs`. Any `--name` not present in `specs` throws
 * `UsageError`. `--` stops flag parsing; everything after it is positional.
 */
export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const specByName = new Map(specs.map((s) => [s.name, s] as const));
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  let sawDoubleDash = false;
  let i = 0;

  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;

    if (!sawDoubleDash && tok === '--') {
      sawDoubleDash = true;
      i += 1;
      continue;
    }

    if (!sawDoubleDash && tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const spec = specByName.get(name);
      if (!spec) {
        throw new UsageError(`unknown flag --${name}`);
      }
      if (spec.type === 'boolean') {
        if (eq !== -1) {
          throw new UsageError(`--${name} does not take a value`);
        }
        flags[name] = true;
        i += 1;
      } else {
        let value: string;
        if (eq !== -1) {
          value = tok.slice(eq + 1);
          i += 1;
        } else {
          const next = argv[i + 1];
          if (next === undefined) {
            throw new UsageError(`--${name} requires a value`);
          }
          value = next;
          i += 2;
        }
        flags[name] = value;
      }
      continue;
    }

    positionals.push(tok);
    i += 1;
  }

  return { positionals, flags };
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBoolean(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true;
}
