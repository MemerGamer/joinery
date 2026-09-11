/**
 * Read-only enforcement for agent runs (SPEC §9, non-negotiable — these
 * agents run against the user's real repo).
 *
 * Two layers:
 *  - `disallowedTools: ['Write', 'Edit', 'NotebookEdit']` (set by the
 *    caller, in `readingOrder.ts`) removes the file-mutation tools outright.
 *  - `agentCanUseTool` (built from `isReadOnlyBashCommand` below) is the
 *    `canUseTool` callback: it auto-approves `Read`/`Grep`/`Glob`, gates
 *    `Bash` through the allowlist predicate, and denies everything else
 *    (Task, WebFetch, WebSearch, MCP tools, ...) — an allowlist, not a
 *    blocklist, so a new tool the SDK adds tomorrow is denied by default.
 *
 * `isReadOnlyBashCommand` is exported and kept pure (no I/O, no SDK types)
 * specifically so it can be unit-tested against smuggling attempts without
 * spinning up a query().
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/** `git log|show|diff|blame|status` (SPEC §9). */
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['log', 'show', 'diff', 'blame', 'status']);

/**
 * The `review` CLI subcommands that only read (SPEC §10's table, minus every
 * mutating route: `create`, `revision`, `viewed`, `reply`, `resolve`,
 * `repos add`, `reading-order set`, `reading-order generate`). SPEC §9 says
 * just "the review CLI itself", but allowing the full CLI would let an
 * agent call `review reading-order set` through Bash and bypass the
 * Write/Edit block entirely — so this list is deliberately narrower than
 * the spec's literal wording. Documented in IMPROVEMENTS.md.
 */
const READ_ONLY_REVIEW_SUBCOMMANDS = new Set(['list', 'show', 'files', 'diff', 'threads', 'thread', 'feedback', 'run']);

/**
 * Shell metacharacters that could chain, substitute, or redirect a second
 * command onto an allowlisted prefix: `;`, `&` (background/`&&`), `|`,
 * backtick command substitution, `$(...)` command substitution, and
 * `<`/`>` redirection. Rejecting the whole command on any of these means an
 * attempt like `git log; rm -rf x` or `cat a > b` never reaches the
 * per-program check below at all.
 */
const SHELL_METACHARACTERS = /[;&|`<>\n\r]|\$\(/;

/**
 * `rg` is allowlisted (SPEC §9), but several ripgrep flags take a COMMAND
 * and execute it: `--pre` runs a preprocessor binary on every searched file,
 * `--hostname-bin` runs a binary to resolve the hostname, and `--search-zip`
 * shells out to decompression helpers. Any of them turns an allowlisted
 * read-only search into arbitrary command execution — `rg --pre=/bin/sh .`
 * is a full escape — so they are rejected even though the program itself is
 * allowed. The shell-metacharacter guard above does NOT catch these: there
 * is no metacharacter involved, `rg` execs the command directly.
 */
const RG_COMMAND_EXECUTING_FLAGS = /^(--pre(=|$)|--hostname-bin(=|$)|--search-zip$|-[a-zA-Z]*z$)/;

function isSafeRgInvocation(args: readonly string[]): boolean {
  return !args.some((arg) => RG_COMMAND_EXECUTING_FLAGS.test(arg));
}

function hasInPlaceFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '-i' || arg === '--in-place' || /^-[a-zA-Z]*i/.test(arg));
}

function isReadOnlyReviewInvocation(tokens: readonly string[]): boolean {
  const sub = tokens[1];
  if (sub === undefined) return false;
  if (sub === 'reading-order') return tokens[2] === 'get';
  if (sub === 'repos') return tokens[2] === 'list';
  return READ_ONLY_REVIEW_SUBCOMMANDS.has(sub);
}

/**
 * Pure predicate: is `command` a read-only invocation of one of the
 * allowlisted programs (SPEC §9)? No I/O, no shelling out — just string
 * inspection, so it's directly unit-testable.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_METACHARACTERS.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  const program = tokens[0];

  switch (program) {
    case 'git':
      return tokens[1] !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(tokens[1]);
    case 'rg':
      return isSafeRgInvocation(tokens.slice(1));
    case 'ls':
    case 'cat':
    case 'head':
      return true;
    case 'sed':
      return tokens[1] === '-n' && !hasInPlaceFlag(tokens.slice(2));
    case 'review':
      return isReadOnlyReviewInvocation(tokens);
    default:
      return false;
  }
}

const DENY = (message: string): PermissionResult => ({ behavior: 'deny', message });
const ALLOW = (input: Record<string, unknown>): PermissionResult => ({ behavior: 'allow', updatedInput: input });

/**
 * The `canUseTool` callback for read-only agent runs. `Read`/`Grep`/`Glob`
 * are auto-approved (SPEC §9); `Bash` is gated through
 * `isReadOnlyBashCommand`; everything else is denied — including tools the
 * SDK might add later, since this is an allowlist.
 */
export const agentCanUseTool: CanUseTool = async (toolName, input) => {
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    return ALLOW(input);
  }
  if (toolName === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return isReadOnlyBashCommand(command) ? ALLOW(input) : DENY(`"${command}" is not on the read-only Bash allowlist (SPEC §9)`);
  }
  return DENY(`tool "${toolName}" is not permitted for a read-only agent run (SPEC §9)`);
};
