/**
 * Reading-order generation (SPEC §9's `reading_order` run kind), the
 * straightforward version: one `query()` call per run, no `resume`, no
 * per-message `agent_event` persistence beyond what `runs.ts` records
 * itself. See IMPROVEMENTS.md for what of §9's full session machinery this
 * intentionally does not implement.
 *
 * The agent explores the review root with read-only tools only
 * (`permissions.ts`) and returns its answer as `outputFormat: 'json_schema'`
 * structured output shaped like `readingOrderPlanSchema` — the model can't
 * hand back free-form prose instead of a plan. The result is still
 * `readingOrderPlanSchema.parse()`d before anything touches the database:
 * structured output is a strong hint to the model, not a guarantee.
 */
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { readingOrderPlanSchema, type FileEntry, type ReadingOrderPlan } from '@review/core';
import { z } from 'zod';
import { AGENT_MODEL_ID } from './model.ts';
import { agentCanUseTool } from './permissions.ts';

const READING_ORDER_JSON_SCHEMA = (() => {
  const schema = z.toJSONSchema(readingOrderPlanSchema) as Record<string, unknown>;
  // The CLI's `--json-schema` flag rejects a top-level `$schema` key ("not a
  // valid JSON Schema: no schema with key or ref ..."), so strip it.
  delete schema['$schema'];
  return schema;
})();

function describeFile(f: FileEntry): string {
  const rename = f.oldPath !== null ? ` (renamed from ${f.oldPath})` : '';
  const counts = f.additions !== null && f.deletions !== null ? ` +${f.additions}/-${f.deletions}` : '';
  return `- ${f.path}${rename} — ${f.status}${f.binary ? ' [binary]' : ''}${counts}`;
}

/**
 * The user prompt for a reading-order run: the changed-file list plus
 * instructions. Exported (and kept free of any SDK call) so its shape is
 * unit-testable without spawning a subprocess.
 */
export function buildReadingOrderPrompt(files: readonly FileEntry[]): string {
  const fileLines = files.map(describeFile).join('\n');
  return [
    'A code reviewer needs a reading order for this review — a sequence of',
    'steps that groups the changed files below into a sensible order to read',
    'them in, each with a short prose explanation of what that step covers.',
    '',
    'Changed files:',
    fileLines,
    '',
    'Explore the review root with your read-only tools (Read/Grep/Glob, and',
    'the read-only `git log`/`git show`/`git diff`/`git blame`/`git status`,',
    '`rg`, `ls`, `cat`, `head`, `sed -n` commands) to understand what changed',
    'and why, then propose a reading order. Every changed file listed above',
    'must appear in exactly one step, under its exact path. Group files that',
    'belong to the same concern into one step rather than one step per file',
    'when that makes for a clearer story. Order steps so foundational or',
    'central changes come first and dependent/peripheral changes (tests,',
    'generated files, minor call-site updates) come later.',
    '',
    'Respond only with the structured output — no other explanation.',
  ].join('\n');
}

export type GenerateReadingOrderPlanOptions = {
  readonly cwd: string;
  readonly files: readonly FileEntry[];
  /** Called with every SDK message as it streams in, for event logging. */
  readonly onMessage?: (message: unknown) => void | Promise<void>;
};

export class ReadingOrderAgentError extends Error {}

/**
 * Runs the agent and returns a validated `ReadingOrderPlan`. Throws
 * `ReadingOrderAgentError` on any failure (turn ended in error, structured
 * output missing, or output that fails `readingOrderPlanSchema`) — the
 * caller (`runs.ts`) is responsible for recording that as the run's error.
 */
export async function generateReadingOrderPlan(options: GenerateReadingOrderPlanOptions): Promise<ReadingOrderPlan> {
  if (options.files.length === 0) {
    throw new ReadingOrderAgentError('review has no changed files to build a reading order from');
  }

  const stream = query({
    prompt: buildReadingOrderPrompt(options.files),
    options: {
      cwd: options.cwd,
      model: AGENT_MODEL_ID,
      disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
      canUseTool: agentCanUseTool,
      // Claude Code has a built-in fast-path that auto-approves bash
      // commands its own classifier judges "obviously read-only" *without*
      // ever calling `canUseTool` — verified empirically (`git log | head`
      // never reached `agentCanUseTool` under the defaults). Forcing every
      // Bash call onto the "ask" tier routes ALL of them through
      // `canUseTool`, making `isReadOnlyBashCommand` the actual, sole
      // enforcement boundary rather than a check the fast-path can skip.
      // `settingSources: []` additionally refuses to load the reviewed
      // repo's own `.claude/settings*.json` — reviewing a branch that adds
      // a permissive `allow` rule there must not be able to reopen this.
      settingSources: [],
      settings: { permissions: { ask: ['Bash'] } },
      outputFormat: { type: 'json_schema', schema: READING_ORDER_JSON_SCHEMA },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          'You are generating a reading order for a code review (read-only). ' +
          'Do not attempt to modify any files or run any command outside your allowlisted, read-only tools.',
      },
      maxTurns: 30,
    },
  });

  let result: SDKResultMessage | undefined;
  for await (const message of stream as AsyncIterable<SDKMessage>) {
    await options.onMessage?.(message);
    if (message.type === 'result') {
      result = message;
    }
  }

  if (result === undefined) {
    throw new ReadingOrderAgentError('agent run ended without a result message');
  }
  if (result.subtype !== 'success' || result.is_error) {
    throw new ReadingOrderAgentError(`agent run did not complete successfully (${result.subtype})`);
  }
  if (result.result.length === 0) {
    throw new ReadingOrderAgentError('agent run produced no structured output');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.result);
  } catch {
    throw new ReadingOrderAgentError('agent output was not valid JSON');
  }

  const parsed = readingOrderPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReadingOrderAgentError(`agent output did not match the reading-order plan shape: ${parsed.error.message}`);
  }
  return parsed.data;
}
