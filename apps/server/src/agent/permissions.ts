/**
 * Read-only, path-fenced enforcement for embedded agent runs (SPEC §9,
 * PLAN.md "agent reply mechanism", design decision 1 — non-negotiable, since
 * these agents run against the user's real repo).
 *
 * The embedded agent (reading order, thread reply) gets **no shell at all**:
 *  - `disallowedTools` (set by each run's caller) includes `'Bash'` alongside
 *    the file-mutation tools, removing it outright.
 *  - `makeAgentCanUseTool({ cwd })` is the `canUseTool` callback: it
 *    auto-approves `Read`/`Grep`/`Glob` only when the path they'd touch
 *    resolves under the run's `cwd` (the attached root or agent worktree —
 *    see `worktree.ts`), allows any `mcp__review__*` tool (the in-process
 *    app tools from `tools.ts`), and denies everything else — an allowlist,
 *    not a blocklist, so a new tool the SDK adds tomorrow is denied by
 *    default.
 *
 * `isReadOnlyBashCommand` is kept exported (its unit tests exist) but is
 * **no longer used by the embedded run** now that Bash is removed entirely;
 * it remains dead-but-tested code documenting the read-only allowlist that
 * used to gate it, in case a future non-embedded run wants Bash back.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
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
 * inspection, so it's directly unit-testable. See the module doc comment:
 * the embedded run no longer exposes `Bash` at all, so nothing calls this
 * from `canUseTool` any more.
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
 * Resolve `candidate` (as `Read`/`Grep`/`Glob` would see it — absolute or
 * relative to `cwd`) to a real path, and check it under `cwd`'s real path.
 * Both sides go through `realpath` so a symlink inside `cwd` can't point
 * the agent outside it. `candidate` itself may not exist yet (`Glob`'s
 * `path` is often a directory that may or may not be there, and a `Read`
 * on a not-yet-existing file should still be fenced, not crash) — in that
 * case fall back to lexical resolution of `candidate` against the real
 * `cwd`, which still catches `../` escapes.
 */
async function isUnderCwd(candidate: string, cwd: string): Promise<boolean> {
  const realCwd = await realpath(cwd);
  const absolute = isAbsolute(candidate) ? candidate : join(cwd, candidate);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    real = resolve(absolute);
  }
  return real === realCwd || real.startsWith(realCwd.endsWith(sep) ? realCwd : `${realCwd}${sep}`);
}

export type MakeAgentCanUseToolOptions = {
  /** The run's cwd (attached root or agent worktree — `worktree.ts`). */
  readonly cwd: string;
};

/**
 * Builds the `canUseTool` callback for an embedded agent run.
 * `Read`/`Grep`/`Glob` are allowed only when the path they'd touch resolves
 * under `cwd`; any `mcp__review__*` tool (the in-process app tools) is
 * always allowed since those are already scoped to the run's review server
 * side; everything else — including `Bash` and any future SDK tool — is
 * denied by default.
 */
export function makeAgentCanUseTool(options: MakeAgentCanUseToolOptions): CanUseTool {
  return async (toolName, input) => {
    if (toolName.startsWith('mcp__review__')) {
      return ALLOW(input);
    }
    if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
      const raw = toolName === 'Read' ? input['file_path'] : input['path'];
      const candidate = typeof raw === 'string' ? raw : options.cwd;
      const allowed = await isUnderCwd(candidate, options.cwd);
      return allowed
        ? ALLOW(input)
        : DENY(`"${candidate}" is outside this run's directory (${options.cwd})`);
    }
    return DENY(`tool "${toolName}" is not permitted for this agent run (no shell — PLAN.md "agent reply mechanism")`);
  };
}
