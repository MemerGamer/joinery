import * as client from '../client.ts';
import { printLine } from '../format.ts';
import type { Command } from './types.ts';
import { maybePrintJson, parseCommand, requirePositional, wantsHelp } from './shared.ts';

export const run: Command = {
  path: 'run',
  summary: 'Show an agent run and its events',
  usage: 'review run <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(run.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.getRun(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(`run       ${result.run.id}`);
    printLine(`kind      ${result.run.kind}`);
    printLine(`status    ${result.run.status}`);
    if (result.run.error !== null) printLine(`error     ${result.run.error}`);
    for (const e of result.events) {
      printLine(`[${e.seq}] ${e.type}`);
    }
  },
};
