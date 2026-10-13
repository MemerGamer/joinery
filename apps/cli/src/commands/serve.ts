/** `joinery serve`: run the server in the foreground (what the LaunchAgent runs). */
import { startServer } from '@joinery/server/start';
import { printLine } from '../format.ts';
import { parseCommand, wantsHelp } from './shared.ts';
import type { Command } from './types.ts';

export const serve: Command = {
  path: 'serve',
  summary: 'Run the Joinery server in the foreground',
  usage: 'joinery serve',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(serve.usage);
    await startServer();
    // The server keeps the event loop alive; park so index.ts doesn't exit.
    await new Promise<void>(() => {});
  },
};
