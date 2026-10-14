import { readFileSync } from 'node:fs';
import { reactionKindSchema, type ReactionKind } from '@joinery/core';
import * as client from '../client.ts';
import { UsageError } from '../args.ts';
import { printLine, printTable, renderThreadsMarkdown } from '../format.ts';
import type { Command } from './types.ts';
import { flagBoolean, flagString } from '../args.ts';
import { maybePrintJson, parseCommand, requireFlag, requirePositional, wantsHelp } from './shared.ts';

export const threads: Command = {
  path: 'threads',
  summary: 'List threads on a review',
  usage: 'joinery threads <id> [--unresolved] [--markdown] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'unresolved', type: 'boolean' }, { name: 'markdown', type: 'boolean' }]);
    if (wantsHelp(parsed)) return printLine(threads.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.listThreads(id, { unresolved: flagBoolean(parsed.flags, 'unresolved') });
    if (maybePrintJson(parsed, result)) return;
    if (flagBoolean(parsed.flags, 'markdown')) {
      process.stdout.write(renderThreadsMarkdown(result.threads));
      return;
    }
    if (result.threads.length === 0) {
      printLine('no threads');
      return;
    }
    printTable(
      ['ID', 'PATH', 'LINES', 'STATUS', 'COMMENTS'],
      result.threads.map((t) => [
        t.id,
        t.path,
        `${t.startLine}-${t.endLine}`,
        t.status,
        String(t.comments.length),
      ]),
    );
  },
};

export const thread: Command = {
  path: 'thread',
  summary: 'Show a thread and its comments',
  usage: 'joinery thread <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(thread.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.getThread(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(`${result.thread.path}:${result.thread.startLine}-${result.thread.endLine} [${result.thread.status}]`);
    for (const c of result.thread.comments) {
      printLine('');
      printLine(`-- ${c.author} --`);
      printLine(c.body);
    }
  },
};

async function readBody(bodyFileFlag: string): Promise<string> {
  if (bodyFileFlag === '-') {
    return await Bun.stdin.text();
  }
  try {
    return readFileSync(bodyFileFlag, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageError(`could not read ${bodyFileFlag}: ${reason}`);
  }
}

export const reply: Command = {
  path: 'reply',
  summary: 'Reply to a thread',
  usage: 'joinery reply <id> --body-file r.md [--actor user|agent] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'body-file', type: 'string' }, { name: 'actor', type: 'string' }]);
    if (wantsHelp(parsed)) return printLine(reply.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const bodyFile = requireFlag(parsed, 'body-file');
    const body = await readBody(bodyFile);
    if (body.trim().length === 0) {
      throw new UsageError(`${bodyFile} is empty — a reply needs a body`);
    }
    const result = await client.reply(id, { body, author: parseActor(parsed), askAgent: false });
    if (maybePrintJson(parsed, result)) return;
    printLine(`replied to thread ${result.thread.id}`);
  },
};

export const comment: Command = {
  path: 'comment',
  summary: 'Start a new thread on a line of a file',
  usage:
    'joinery comment <reviewId> <path> --line N [--end M] [--side old|new] (--body-file <f> | --body-file -) [--actor user|agent] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [
      { name: 'line', type: 'string' },
      { name: 'end', type: 'string' },
      { name: 'side', type: 'string' },
      { name: 'body-file', type: 'string' },
      { name: 'actor', type: 'string' },
    ]);
    if (wantsHelp(parsed)) return printLine(comment.usage);
    const id = requirePositional(parsed.positionals, 0, 'reviewId');
    const path = requirePositional(parsed.positionals, 1, 'path');
    const startLine = parseLine(requireFlag(parsed, 'line'), 'line');
    const endFlag = flagString(parsed.flags, 'end');
    const endLine = endFlag === undefined ? startLine : parseLine(endFlag, 'end');
    if (endLine < startLine) throw new UsageError('--end must be >= --line');
    const side = flagString(parsed.flags, 'side') ?? 'new';
    if (side !== 'old' && side !== 'new') {
      throw new UsageError(`--side must be "old" or "new", got "${side}"`);
    }
    const bodyFile = requireFlag(parsed, 'body-file');
    const body = await readBody(bodyFile);
    if (body.trim().length === 0) {
      throw new UsageError(`${bodyFile} is empty — a comment needs a body`);
    }
    const result = await client.createThread(id, { path, side, startLine, endLine, body, author: parseActor(parsed), askAgent: false });
    if (maybePrintJson(parsed, result)) return;
    printLine(`created thread ${result.thread.id}`);
  },
};

/** `--actor`: who the comment is from. Agents pass `agent` so their words don't show up as the user's. */
function parseActor(parsed: ReturnType<typeof parseCommand>): 'user' | 'agent' {
  const actor = flagString(parsed.flags, 'actor') ?? 'user';
  if (actor !== 'user' && actor !== 'agent') {
    throw new UsageError(`--actor must be "user" or "agent", got "${actor}"`);
  }
  return actor;
}

function parseLine(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${flag} must be a positive integer, got "${raw}"`);
  return n;
}

export const resolve: Command = {
  path: 'resolve',
  summary: 'Resolve a thread',
  usage: 'joinery resolve <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(resolve.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.resolveThread(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(`thread ${result.thread.id} resolved`);
  },
};

/** Without `--yes`, deletes only say what they would remove. */
function requireYes(parsed: ReturnType<typeof parseCommand>, what: string): void {
  if (flagBoolean(parsed.flags, 'yes')) return;
  throw new UsageError(`this would delete ${what} — pass --yes to delete it`);
}

export const deleteThread: Command = {
  path: 'delete-thread',
  summary: 'Delete a thread and all its comments (needs --yes)',
  usage: 'joinery delete-thread <id> --yes [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'yes', type: 'boolean' }]);
    if (wantsHelp(parsed)) return printLine(deleteThread.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const { thread: t } = await client.getThread(id);
    const n = t.comments.length;
    requireYes(parsed, `thread ${t.id} on ${t.path}:${t.startLine}-${t.endLine} (${n} ${n === 1 ? 'comment' : 'comments'})`);
    const result = await client.deleteThread(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(`deleted thread ${id}`);
  },
};

export const deleteComment: Command = {
  path: 'delete-comment',
  summary: "Delete a comment (deleting a thread's last comment deletes the thread; needs --yes)",
  usage: 'joinery delete-comment <commentId> --yes [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'yes', type: 'boolean' }]);
    if (wantsHelp(parsed)) return printLine(deleteComment.usage);
    const id = requirePositional(parsed.positionals, 0, 'commentId');
    const { threadId } = await client.getComment(id);
    const { thread: t } = await client.getThread(threadId);
    const last = t.comments.length === 1;
    requireYes(parsed, `comment ${id} on thread ${threadId}${last ? ' — its last comment, so the thread goes too' : ''}`);
    const result = await client.deleteComment(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(result.thread === null ? `deleted comment ${id} and thread ${threadId}` : `deleted comment ${id}`);
  },
};

const EMOJI_TO_KIND: Readonly<Record<string, ReactionKind>> = {
  '👍': 'thumbs_up',
  '👎': 'thumbs_down',
  '👀': 'eyes',
  '✅': 'check',
  '❓': 'question',
  '🎉': 'tada',
};

function parseKind(raw: string): ReactionKind {
  const emojiMatch = EMOJI_TO_KIND[raw];
  if (emojiMatch !== undefined) return emojiMatch;
  const parsed = reactionKindSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`invalid reaction kind "${raw}" (expected one of ${reactionKindSchema.options.join(', ')}, or an emoji)`);
  }
  return parsed.data;
}

export const react: Command = {
  path: 'react',
  summary: 'Set or clear a reaction on a comment',
  usage: 'joinery react <commentId> <kind> [--off] [--actor user|agent] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'off', type: 'boolean' }, { name: 'actor', type: 'string' }]);
    if (wantsHelp(parsed)) return printLine(react.usage);
    const commentId = requirePositional(parsed.positionals, 0, 'commentId');
    const kind = parseKind(requirePositional(parsed.positionals, 1, 'kind'));
    const actorFlag = parseActor(parsed);
    const on = !flagBoolean(parsed.flags, 'off');
    const result = await client.setReaction(commentId, { kind, actor: actorFlag, on });
    if (maybePrintJson(parsed, result)) return;
    printLine(`${on ? 'reacted' : 'removed reaction'} ${kind} on comment ${commentId} as ${actorFlag}`);
  },
};
