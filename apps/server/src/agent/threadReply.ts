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
import { createReviewTools, trimToLines, type Invoke } from './tools.ts';
import { resolveRunCwd, type EngineForCwd } from './worktree.ts';
import { appendEvent, type Db } from '../db/index.ts';

export type ThreadReplyDeps = {
  readonly db: Db;
  readonly invoke: Invoke;
  readonly emit: (event: ServerEvent) => void;
};

type ReviewDetail = { review: Review; repo: { remoteOwner: string | null; remoteName: string | null; rootPath: string } };
type ReadingOrderSummary = { readingOrder: { steps: { title: string }[] } | null };
type DiffResponse = { patch: { patch: string } };

function repoLabel(repo: ReviewDetail['repo']): string {
  return repo.remoteOwner !== null && repo.remoteName !== null ? `${repo.remoteOwner}/${repo.remoteName}` : repo.rootPath;
}

async function fetchJson<T>(invoke: Invoke, method: string, path: string): Promise<T> {
  const res = await invoke(method, path);
  if (!res.ok) throw new Error(`${method} ${path} failed (${String(res.status)}): ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Assembles the run's system-prompt append and user message: the review
 * header, the reading order's step titles (so the agent knows where this
 * thread sits in the bigger picture), the thread rendered as `author: body`
 * in order, its anchor (`path:startLine-endLine` plus the captured context),
 * and the diff for that path trimmed to 200 lines. Exported (and kept free
 * of any SDK call) so its shape is inspectable without spawning a
 * subprocess, matching `buildReadingOrderPrompt`.
 */
export function buildThreadReplyPrompt(input: {
  review: Review;
  repo: ReviewDetail['repo'];
  readingOrderTitles: readonly string[];
  thread: Thread;
  diffText: string;
}): { systemPromptAppend: string; userMessage: string } {
  const { review, repo, readingOrderTitles, thread, diffText } = input;

  const systemPromptAppend = [
    'You are the review assistant for one code review. You cannot edit code —',
    'you have no Write, Edit, or shell access at all. Act on the review through',
    'the `joinery` tools: reply, react, create_thread, resolve_thread,',
    'mark_viewed, set_reading_order, set_review_status. Answer the latest user',
    'message in the thread below by calling `reply` with that thread\'s id (given',
    'in the thread header); text you write outside a tool call is not shown to',
    'the user. Keep replies short and grounded in specific',
    "file paths and line numbers. Don't resolve a thread unless the user",
    'explicitly asked you to. Prefer `react` over a reply for a plain',
    'acknowledgement.',
  ].join(' ');

  const header = [
    `Repo: ${repoLabel(repo)}`,
    `Branch: ${review.branch ?? review.pinnedSha ?? '(detached)'}`,
    `Base: ${review.baseRef}`,
    review.prNumber !== null ? `PR: #${String(review.prNumber)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const readingOrderSection =
    readingOrderTitles.length === 0
      ? 'Reading order: not generated yet.'
      : `Reading order steps:\n${readingOrderTitles.map((title, i) => `${String(i + 1)}. ${title}`).join('\n')}`;

  const threadBody = thread.comments.map((c) => `${c.author}: ${c.body}`).join('\n\n');

  const userMessage = [
    header,
    '',
    readingOrderSection,
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

  return { systemPromptAppend, userMessage };
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

  const [{ repo }, { readingOrder }, { patch }] = await Promise.all([
    fetchJson<ReviewDetail>(deps.invoke, 'GET', `/api/reviews/${encodeURIComponent(review.id)}`),
    fetchJson<ReadingOrderSummary>(deps.invoke, 'GET', `/api/reviews/${encodeURIComponent(review.id)}/reading-order`),
    fetchJson<DiffResponse>(deps.invoke, 'GET', `/api/reviews/${encodeURIComponent(review.id)}/diff?path=${encodeURIComponent(thread.path)}`),
  ]);

  const { systemPromptAppend, userMessage } = buildThreadReplyPrompt({
    review,
    repo,
    readingOrderTitles: (readingOrder?.steps ?? []).map((s) => s.title),
    thread,
    diffText: trimToLines(patch.patch, 200),
  });

  const tools = createReviewTools({ invoke: deps.invoke, reviewId: review.id, runId });

  const stream = query({
    prompt: userMessage,
    options: {
      ...claudeExecutableOption(),
      abortController,
      cwd,
      model,
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
      canUseTool: makeAgentCanUseTool({ cwd }),
      mcpServers: { joinery: tools.server },
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend },
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
