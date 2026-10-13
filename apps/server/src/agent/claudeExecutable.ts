/**
 * Locates the Claude Code executable for `query()` calls. The Agent SDK finds
 * its bundled native binary relative to its own files, which does not work
 * inside a `bun build --compile` executable — so in `installed` mode we use
 * the user's own `claude` from PATH. In dev the SDK default is left alone.
 */
import { runtimeLayout } from '../runtime.ts';

export const CLAUDE_NOT_FOUND_MESSAGE =
  'Claude Code not found on PATH — install it and run `claude` once to log in';

/** Spread into `query()` options. Throws with a clear message if `claude` is missing when installed. */
export function claudeExecutableOption(): { pathToClaudeCodeExecutable?: string } {
  if (runtimeLayout().mode !== 'installed') return {};
  const path = Bun.which('claude');
  if (path === null) throw new Error(CLAUDE_NOT_FOUND_MESSAGE);
  return { pathToClaudeCodeExecutable: path };
}
