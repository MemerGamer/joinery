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
    'message in the thread below. Keep replies short and grounded in specific',
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

  const threadBody = thread.comments.map((c) => `${c.author}: ${c.bodyMd}`).join('\n\n');

  const userMessage = [
    header,
    '',
    readingOrderSection,
    '',
    `Thread on ${thread.path}:${String(thread.startLine)}-${String(thread.endLine)} (${thread.side} side):`,
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
      cwd,
      model,
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
      canUseTool: makeAgentCanUseTool({ cwd }),
      mcpServers: { review: tools.server },
      settingSources: [],
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend },
      maxTurns: 40,
    },
  });

  // Partial `stream_event` messages (one per streamed text chunk) are only
  // forwarded live as `run.delta` — never persisted. The complete
  // assistant/user/result messages that follow them carry the same content,
  // so storing every chunk would only multiply `agent_event` rows.
  let deltaSeq = 0;
  for await (const message of stream as AsyncIterable<SDKMessage>) {
    const deltaText = extractDeltaText(message);
    if (deltaText !== null) {
      deltaSeq += 1;
      deps.emit({
        type: 'run.delta',
        reviewId: review.id,
        runId,
        seq: deltaSeq,
        messageType: message.type,
        payload: { text: deltaText },
      });
      continue;
    }
    if (message.type === 'stream_event') continue;
    await appendEvent(deps.db, runId, message.type, message);
  }

  if (!tools.wasWritten()) {
    await deps.invoke('POST', `/api/threads/${encodeURIComponent(thread.id)}/replies`, {
      bodyMd: 'Looked at this and had nothing to add.',
      author: 'agent',
      agentRunId: runId,
    });
  }
}

/** Text of a `content_block_delta` `text_delta` event, or `null` for any other message. */
function extractDeltaText(message: SDKMessage): string | null {
  if (message.type !== 'stream_event') return null;
  const event = (message as { event?: unknown }).event as
    | { type?: string; delta?: { type?: string; text?: string } }
    | undefined;
  if (event?.type !== 'content_block_delta') return null;
  if (event.delta?.type !== 'text_delta') return null;
  return event.delta.text ?? null;
}
