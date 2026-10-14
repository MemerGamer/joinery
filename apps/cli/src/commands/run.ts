import { flagBoolean } from '../args.ts';
import * as client from '../client.ts';
import { printLine } from '../format.ts';
import type { Command } from './types.ts';
import { maybePrintJson, parseCommand, requirePositional, wantsHelp } from './shared.ts';

export const run: Command = {
  path: 'run',
  summary: 'Show an agent run and its events, or cancel it',
  usage: 'joinery run <id> [--cancel] [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'cancel', type: 'boolean' }]);
    if (wantsHelp(parsed)) return printLine(run.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    if (flagBoolean(parsed.flags, 'cancel')) {
      const cancelled = await client.cancelRun(id);
      if (maybePrintJson(parsed, cancelled)) return;
      printLine(`run       ${cancelled.run.id}`);
      printLine(`status    ${cancelled.run.status}`);
      return;
    }
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
