/**
 * `joinery service install|uninstall|status`: manage the launchd LaunchAgent
 * that keeps `joinery serve` running in the background.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_LABEL, dataDirRoot, runtimeLayout } from '@joinery/server/runtime';
import { UsageError } from '../args.ts';
import { printLine } from '../format.ts';
import { parseCommand, wantsHelp } from './shared.ts';
import type { Command } from './types.ts';

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/** The launchd domain target of the current user's GUI session. */
export function serviceTarget(): string {
  return `gui/${process.getuid?.() ?? 501}/${SERVICE_LABEL}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function renderPlist(binary: string, logFile: string, path: string): string {
  const e = escapeXml;
  // The port is not baked in: the server reads it from the data dir's `.port`.
  const extraEnv = ['JOINERY_DATA_DIR']
    .filter((k) => process.env[k])
    .map((k) => `\n    <key>${k}</key><string>${e(process.env[k] ?? '')}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${e(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array><string>${e(binary)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${e(path)}</string>
    <key>JOINERY_HOME</key><string>${e(runtimeLayout().home)}</string>${extraEnv}
  </dict>
  <key>StandardOutPath</key><string>${e(logFile)}</string>
  <key>StandardErrorPath</key><string>${e(logFile)}</string>
</dict>
</plist>
`;
}

async function launchctl(args: readonly string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

async function isLoaded(): Promise<{ loaded: boolean; running: boolean }> {
  const res = await launchctl(['print', serviceTarget()]);
  return { loaded: res.code === 0, running: res.code === 0 && /state = running/.test(res.out) };
}

async function install(): Promise<void> {
  const layout = runtimeLayout();
  if (layout.mode !== 'installed') {
    throw new Error('this is a source checkout — the service runs the installed binary (see scripts/install.sh)');
  }
  const binary = join(layout.home, 'current', 'joinery');
  const logFile = join(dataDirRoot(), 'logs', 'server.log');
  await mkdir(join(dataDirRoot(), 'logs'), { recursive: true });
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  const path = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  await writeFile(plistPath(), renderPlist(binary, logFile, path));

  if ((await isLoaded()).loaded) {
    await launchctl(['bootout', serviceTarget()]);
    // bootout returns before teardown finishes; wait for the job to disappear.
    for (let i = 0; i < 50 && (await isLoaded()).loaded; i++) await sleep(100);
  }
  let res = await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath()]);
  for (let i = 0; i < 5 && res.code !== 0; i++) {
    await sleep(300);
    res = await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath()]);
  }
  if (res.code !== 0) throw new Error(`launchctl bootstrap failed: ${res.out.trim()}`);
  printLine(`service installed (${SERVICE_LABEL}); logs: ${logFile}`);
}

async function uninstall(): Promise<void> {
  if ((await isLoaded()).loaded) await launchctl(['bootout', serviceTarget()]);
  await rm(plistPath(), { force: true });
  printLine('service uninstalled');
}

async function status(): Promise<void> {
  const { loaded, running } = await isLoaded();
  printLine(`plist     ${existsSync(plistPath()) ? plistPath() : 'not installed'}`);
  printLine(`loaded    ${loaded ? 'yes' : 'no'}`);
  printLine(`running   ${running ? 'yes' : 'no'}`);
  printLine(`version   ${runtimeLayout().version}`);
}

export const service: Command = {
  path: 'service',
  summary: 'Manage the background server (macOS LaunchAgent)',
  usage: 'joinery service <install|uninstall|status>',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(service.usage);
    const action = parsed.positionals[0];
    if (action === 'install') return install();
    if (action === 'uninstall') return uninstall();
    if (action === 'status') return status();
    throw new UsageError(`usage: ${service.usage}`);
  },
};
