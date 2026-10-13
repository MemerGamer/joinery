/** `joinery open`: open the web UI in the default browser. */
import { baseUrl } from '../client.ts';
import { printLine } from '../format.ts';
import { parseCommand, wantsHelp } from './shared.ts';
import type { Command } from './types.ts';

export const open: Command = {
  path: 'open',
  summary: 'Open the web UI in your browser',
  usage: 'joinery open',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(open.usage);
    const url = baseUrl();
    const proc = Bun.spawn(['open', url], { stdout: 'inherit', stderr: 'inherit' });
    if ((await proc.exited) !== 0) throw new Error(`could not open ${url}`);
    printLine(url);
  },
};
