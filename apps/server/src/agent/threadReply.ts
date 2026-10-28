/**
 * The `thread_reply` run kind.
 * Mirrors `readingOrder.ts`'s shape (one `query()` per run, every SDK
 * message persisted via `appendEvent`) but the agent here acts through the
 * `joinery` MCP tools (`tools.ts`) instead of returning structured output,
 * and the "reply" it's asked for is a trigger, not a contract (design
 * decision 4): if it ends having written nothing, the caller (`runs.ts`)
 * appends a fallback reply so the click that started it never vanishes
 * silently.
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentModel, Review, ServerEvent, Thread } from '@joinery/core';
import { isAbsolute, relative } from 'node:path';
import { claudeExecutableOption } from './claudeExecutable.ts';
import { AGENT_MODEL_ID } from './model.ts';
import { makeAgentCanUseTool } from './permissions.ts';
import { gitToolDefinitions } from './gitTools.ts';
import { createReviewTools, trimToLines, type Invoke } from './tools.ts';
import { AGENT_SYSTEM_APPEND, buildPrompt, buildReviewContext, loadReviewContext } from './reviewContext.ts';
import { resolveRunCwd, type EngineForCwd } from './worktree.ts';
import { appendEvent, type Db } from '../db/index.ts';

export type ThreadReplyDeps = {
  readonly db: Db;
  readonly invoke: Invoke;
  readonly emit: (event: ServerEvent) => void;
};

type DiffResponse = { patch: { patch: string } };

async function fetchJson<T>(invoke: Invoke, method: string, path: string): Promise<T> {
  const res = await invoke(method, path);
  if (!res.ok) throw new Error(`${method} ${path} failed (${String(res.status)}): ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * The run's task, after the shared review context: what to do, then the
 * thread rendered as `author: body` in order, its anchor
 * (`path:startLine-endLine` plus the captured context), and the diff for
 * that path trimmed to 200 lines. Exported (and kept free of any SDK call)
 * so its shape is inspectable without spawning a subprocess.
 */
export function buildThreadReplyTask(input: { thread: Thread; diffText: string }): string {
  const { thread, diffText } = input;
  const threadBody = thread.comments.map((c) => `${c.author}: ${c.body}`).join('\n\n');
  return [
    '# Your task',
    '',
    'Answer the latest user message in the thread below by calling `reply`',
    "with that thread's id (given in the thread header). Don't resolve a",
    'thread unless the user explicitly asked you to. Prefer `react` over a',
    'reply for a plain acknowledgement. You may use every joinery tool:',
    'reply, react, create_thread, resolve_thread, mark_viewed,',
    'set_reading_order, set_review_status.',
    '',
    `Thread ${thread.id} on ${thread.path}:${String(thread.startLine)}-${String(thread.endLine)} (${thread.side} side):`,
    '',
    threadBody,
    '',
    'Anchor context (the lines the thread is attached to, captured when it was created):',
    thread.anchorContext,
    '',
    `Diff for ${thread.path}:`,
    diffText,
  ].join('\n');
}

/**
 * Runs the agent for one `thread_reply` run and resolves once the agent
 * has finished (or rejects if it failed). It never touches the run row's
 * status: `runs.ts` owns creating and ending the run, and emits `run.ended`.
 */
export async function runThreadReplyAgent(
  deps: ThreadReplyDeps,
  runId: string,
  review: Review,
  thread: Thread,
  engine: EngineForCwd,
  abortController: AbortController,
  model: AgentModel = AGENT_MODEL_ID,
): Promise<void> {
  const cwd = await resolveRunCwd({ db: deps.db }, review, engine);

  const [contextInput, { patch }] = await Promise.all([
    loadReviewContext(deps.db, review, engine.getFileList().files),
    fetchJson<DiffResponse>(deps.invoke, 'GET', `/api/reviews/${encodeURIComponent(review.id)}/diff?path=${encodeURIComponent(thread.path)}`),
  ]);
  const task = buildThreadReplyTask({ thread, diffText: trimToLines(patch.patch, 200) });

  const tools = createReviewTools({ invoke: deps.invoke, reviewId: review.id, runId, extraTools: gitToolDefinitions({ cwd }) });

  const stream = query({
    prompt: buildPrompt(buildReviewContext(contextInput), task),
    options: {
      ...claudeExecutableOption(),
      abortController,
      cwd,
      model,
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
      canUseTool: makeAgentCanUseTool({ cwd }),
      mcpServers: { joinery: tools.server },
      settingSources: [],
      // No saved transcript and no generated title, as for reading orders.
      persistSession: false,
      title: 'Joinery: thread reply',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: AGENT_SYSTEM_APPEND },
      maxTurns: 40,
    },
  });

  // Text of the latest assistant message: if the agent ends without having
  // written anything (e.g. it answered as plain final text), that is the
  // best candidate for the reply.
  let lastText = '';
  for await (const message of stream as AsyncIterable<SDKMessage>) {
    for (const label of toolActivityLabels(message, cwd)) {
      deps.emit({ type: 'run.activity', reviewId: review.id, runId, label });
    }
    if (message.type === 'assistant') lastText = assistantText(message);
    await appendEvent(deps.db, runId, message.type, message);
  }

  if (!abortController.signal.aborted && !tools.wasWritten()) {
    await deps.invoke('POST', `/api/threads/${encodeURIComponent(thread.id)}/replies`, {
      body: lastText !== '' ? lastText : 'Looked at this and had nothing to add.',
      author: 'agent',
      agentRunId: runId,
    });
  }
}

/** Concatenated text blocks of a complete assistant message, trimmed ('' for a tool-only message). */
function assistantText(message: SDKMessage): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return '';
  return (content as { type?: string; text?: unknown }[])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

/** Short labels ("Reading `src/foo.ts`") for each tool call in a complete assistant message. */
function toolActivityLabels(message: SDKMessage, cwd: string): string[] {
  if (message.type !== 'assistant') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const labels: string[] = [];
  for (const block of content as { type?: string; name?: string; input?: unknown }[]) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      labels.push(describeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>, cwd));
    }
  }
  return labels;
}

function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
  const str = (key: string): string | null => (typeof input[key] === 'string' && input[key] !== '' ? (input[key] as string) : null);
  const rel = (path: string): string => {
    const r = relative(cwd, path);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r : path;
  };
  switch (name) {
    case 'Read': {
      const path = str('file_path');
      return path === null ? 'Reading' : `Reading \`${rel(path)}\``;
    }
    case 'Grep': {
      const pattern = str('pattern');
      return pattern === null ? 'Searching' : `Searching for \`${pattern}\``;
    }
    case 'Glob': {
      const pattern = str('pattern');
      return pattern === null ? 'Listing files' : `Listing \`${pattern}\``;
    }
    case 'mcp__joinery__reply':
      return 'Writing reply';
    default:
      return name.startsWith('mcp__joinery__git_') ? 'Checking git history' : name;
  }
}
