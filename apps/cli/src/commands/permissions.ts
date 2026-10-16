/**
 * `joinery permissions`: walk the user through granting Full Disk Access to
 * the installed binary, so macOS stops prompting per protected folder
 * (Desktop, Documents, Downloads, iCloud Drive, external volumes) and
 * forgets an earlier "Don't Allow". macOS offers no API to grant this — the
 * user has to flip the switch — so this opens the right pane, reveals the
 * binary to add, and restarts the service once they're done.
 */
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runtimeLayout } from '@joinery/server/runtime';
import { printLine } from '../format.ts';
import { restartService } from './service.ts';
import { parseCommand, wantsHelp } from './shared.ts';
import type { Command } from './types.ts';

const FULL_DISK_ACCESS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

async function openUrl(target: string, reveal = false): Promise<void> {
  const proc = Bun.spawn(['open', ...(reveal ? ['-R'] : []), target], { stdout: 'ignore', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`could not open ${target}`);
}

export const permissions: Command = {
  path: 'permissions',
  summary: 'Grant the background server Full Disk Access (macOS)',
  usage: 'joinery permissions',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(permissions.usage);
    if (process.platform !== 'darwin') return printLine('nothing to do: folder permissions are a macOS thing');
    const layout = runtimeLayout();
    if (layout.mode !== 'installed') {
      throw new Error('this is a source checkout — grant Full Disk Access to your terminal instead');
    }
    // macOS keys the grant on the real file; older installs had `current` as a symlink.
    const binary = await realpath(join(layout.home, 'current', 'joinery'));

    printLine('Opening System Settings → Privacy & Security → Full Disk Access');
    printLine('and revealing the joinery binary in Finder:');
    printLine('');
    printLine(`  ${binary}`);
    printLine('');
    printLine('Drag it into the Full Disk Access list (or click + and pick it), then make sure');
    printLine('its switch is on. This also overrides an earlier "Don\'t Allow".');
    await openUrl(FULL_DISK_ACCESS_PANE);
    await openUrl(binary, true);

    if (!process.stdin.isTTY) {
      printLine('');
      printLine('When done, restart the service: joinery service install');
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('\nPress Enter once joinery is switched on… ');
    } finally {
      rl.close();
    }
    if (await restartService()) printLine('service restarted — folders should open without prompts now');
    else printLine('the service is not installed; restart `joinery serve` if it is running');
  },
};
