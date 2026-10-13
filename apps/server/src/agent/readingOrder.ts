/**
 * Reading-order generation (the `reading_order` run kind), the
 * straightforward version: one `query()` call per run, no `resume`, no
 * per-message `agent_event` persistence beyond what `runs.ts` records
 * itself. Much of the full session machinery is intentionally not
 * implemented.
 *
 * The agent explores the review root with read-only, path-fenced tools only
 * (`permissions.ts`'s `makeAgentCanUseTool`, no shell) and returns its
 * answer as `outputFormat: 'json_schema'`
 * structured output shaped like `readingOrderPlanSchema` — the model can't
 * hand back free-form prose instead of a plan. The result is still
 * `readingOrderPlanSchema.parse()`d before anything touches the database:
 * structured output is a strong hint to the model, not a guarantee.
 */
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { readingOrderPlanSchema, type FileEntry, type ReadingOrderPlan } from '@joinery/core';
import { z } from 'zod';
import { claudeExecutableOption } from './claudeExecutable.ts';
import { READING_ORDER_MODEL_ID } from './model.ts';
import { makeAgentCanUseTool } from './permissions.ts';

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
    'Turn this code review into a walkthrough: a short series of steps a',
    'teammate reads in order, each covering one concern of the change.',
    '',
    'Changed files:',
    fileLines,
    '',
    '1. Read each changed file in the review root (Read, Grep, Glob). Done when',
    '   you can say in one sentence what every file adds or changes.',
    '2. Group the files by concern. Done when every changed file sits in',
    '   exactly one step, under its exact path.',
    '3. Order the steps by dependency: definitions and contracts before the code',
    '   that uses them, call sites and tests last. Done when each step comes after',
    '   the steps it builds on.',
    '4. Write each step following the descriptions in the output schema.',
    '',
    'Respond only with the structured output.',
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

  let executable: ReturnType<typeof claudeExecutableOption>;
  try {
    executable = claudeExecutableOption();
  } catch (err) {
    throw new ReadingOrderAgentError(err instanceof Error ? err.message : String(err));
  }

  const stream = query({
    prompt: buildReadingOrderPrompt(options.files),
    options: {
      ...executable,
      cwd: options.cwd,
      model: READING_ORDER_MODEL_ID,
      // `Bash` is removed outright rather than gated through a read-only
      // allowlist: no shell at all for the embedded agent, on either run kind.
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
      canUseTool: makeAgentCanUseTool({ cwd: options.cwd }),
      // Refuses to load the reviewed repo's own `.claude/settings*.json` —
      // reviewing a branch that adds a permissive `allow` rule there must
      // not be able to reopen tool access this run intentionally removed.
      settingSources: [],
      outputFormat: { type: 'json_schema', schema: READING_ORDER_JSON_SCHEMA },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          'You are writing a walkthrough of a code review for a teammate. ' +
          'Your tools are read-only: Read, Grep, Glob.',
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
