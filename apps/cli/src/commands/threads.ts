import { readFileSync } from 'node:fs';
import * as client from '../client.ts';
import { UsageError } from '../args.ts';
import { printLine, printTable } from '../format.ts';
import type { Command } from './types.ts';
import { flagBoolean } from '../args.ts';
import { maybePrintJson, parseCommand, requireFlag, requirePositional, wantsHelp } from './shared.ts';

export const threads: Command = {
  path: 'threads',
  summary: 'List threads on a review',
  usage: 'review threads <id> [--unresolved] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'unresolved', type: 'boolean' }]);
    if (wantsHelp(parsed)) return printLine(threads.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.listThreads(id, { unresolved: flagBoolean(parsed.flags, 'unresolved') });
    if (maybePrintJson(parsed, result)) return;
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
  usage: 'review thread <id> [--json]',
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
      printLine(c.bodyMd);
    }
  },
};

async function readBodyMd(bodyFileFlag: string): Promise<string> {
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
  usage: 'review reply <id> --body-file r.md [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'body-file', type: 'string' }]);
    if (wantsHelp(parsed)) return printLine(reply.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const bodyFile = requireFlag(parsed, 'body-file');
    const bodyMd = await readBodyMd(bodyFile);
    if (bodyMd.trim().length === 0) {
      throw new UsageError(`${bodyFile} is empty — a reply needs a body`);
    }
    const result = await client.reply(id, { bodyMd, author: 'user', askAgent: false });
    if (maybePrintJson(parsed, result)) return;
    printLine(`replied to thread ${result.thread.id}`);
  },
};

export const resolve: Command = {
  path: 'resolve',
  summary: 'Resolve a thread',
  usage: 'review resolve <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(resolve.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.resolveThread(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(`thread ${result.thread.id} resolved`);
  },
};

export const feedback: Command = {
  path: 'feedback',
  summary: 'Print review feedback as markdown',
  usage: 'review feedback <id> [--unresolved] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'unresolved', type: 'boolean' }]);
    if (wantsHelp(parsed)) return printLine(feedback.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.feedback(id, { unresolved: flagBoolean(parsed.flags, 'unresolved') });
    if (maybePrintJson(parsed, result)) return;
    process.stdout.write(result.markdown);
    if (!result.markdown.endsWith('\n')) process.stdout.write('\n');
  },
};
