import { resolve } from 'node:path';
import * as client from '../client.ts';
import { printLine, printTable } from '../format.ts';
import type { Command } from './types.ts';
import { maybePrintJson, parseCommand, requirePositional, wantsHelp } from './shared.ts';

export const reposList: Command = {
  path: 'repos list',
  summary: 'List registered repos',
  usage: 'review repos list [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(reposList.usage);
    const result = await client.listRepos();
    if (maybePrintJson(parsed, result)) return;
    if (result.repos.length === 0) {
      printLine('no repos registered — run `review repos add <path>`');
      return;
    }
    printTable(
      ['ID', 'ROOT', 'DEFAULT BRANCH'],
      result.repos.map((r) => [r.id, r.rootPath, r.defaultBranch]),
    );
  },
};

export const reposAdd: Command = {
  path: 'repos add',
  summary: 'Register a repo by path',
  usage: 'review repos add <path> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(reposAdd.usage);
    // Resolved here, against the *client's* cwd: the server runs in its own
    // directory, so a relative path sent over the wire would silently register
    // whatever `.` means to the server instead of what the user typed.
    const path = resolve(requirePositional(parsed.positionals, 0, 'path'));
    const result = await client.addRepo({ path });
    if (maybePrintJson(parsed, result)) return;
    printLine(`added repo ${result.repo.id} at ${result.repo.rootPath}`);
  },
};
