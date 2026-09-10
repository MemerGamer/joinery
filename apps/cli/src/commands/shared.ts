import { type FlagSpec, type ParsedArgs, UsageError, flagBoolean, parseArgs } from '../args.ts';
import { printJson } from '../format.ts';

export const JSON_FLAG: FlagSpec = { name: 'json', type: 'boolean' };
export const HELP_FLAG: FlagSpec = { name: 'help', type: 'boolean' };

/** Parses `argv` for a leaf command, always accepting `--json` and `--help`. */
export function parseCommand(argv: readonly string[], extra: readonly FlagSpec[] = []): ParsedArgs {
  return parseArgs(argv, [JSON_FLAG, HELP_FLAG, ...extra]);
}

export function wantsJson(parsed: ParsedArgs): boolean {
  return flagBoolean(parsed.flags, 'json');
}

export function wantsHelp(parsed: ParsedArgs): boolean {
  return flagBoolean(parsed.flags, 'help');
}

/** Prints the API response and stops, when `--json` was passed. Returns whether it did. */
export function maybePrintJson(parsed: ParsedArgs, value: unknown): boolean {
  if (wantsJson(parsed)) {
    printJson(value);
    return true;
  }
  return false;
}

export function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) {
    throw new UsageError(`missing required argument <${name}>`);
  }
  return value;
}

export function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = parsed.flags[name];
  if (typeof value !== 'string') {
    throw new UsageError(`missing required flag --${name}`);
  }
  return value;
}
