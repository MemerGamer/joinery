/**
 * `joinery update`: install a newer release next to the current one, repoint
 * `~/.joinery/current`, and restart the service.
 *
 * Layout and steps mirror scripts/install.sh. Every step is atomic: the
 * tarball is extracted into a temp sibling dir then renamed into
 * `versions/<v>`, and `current` is swapped via a temp symlink + rename.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { RELEASE_REPO, runtimeLayout } from '@joinery/server/runtime';
import { UsageError, flagBoolean, flagString } from '../args.ts';
import { printLine } from '../format.ts';
import { parseCommand, wantsHelp } from './shared.ts';
import { plistPath, serviceTarget } from './service.ts';
import type { Command } from './types.ts';

/** How many version dirs to keep (the new one, the previous one, and one more). */
const KEEP_VERSIONS = 3;

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function assetName(version: string): string {
  return `joinery-${version}-darwin-arm64.tar.gz`;
}

function assetUrl(version: string, suffix = ''): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${assetName(version)}${suffix}`;
}

async function latestVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'joinery-cli' },
  });
  if (!res.ok) throw new Error(`could not look up the latest release (HTTP ${res.status})`);
  const body = (await res.json()) as { tag_name?: unknown };
  if (typeof body.tag_name !== 'string') throw new Error('latest release has no tag_name');
  return body.tag_name.replace(/^v/, '');
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'user-agent': 'joinery-cli' } });
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  await Bun.write(dest, res);
}

async function sha256(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

async function run(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdout: 'ignore', stderr: 'inherit' });
  return proc.exited;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new UsageError('refusing to update without confirmation on a non-interactive terminal; pass --yes');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Repoint `current` at `versions/<version>` via temp symlink + rename. */
async function repointCurrent(home: string, version: string): Promise<void> {
  const tmpLink = join(home, `.current-${process.pid}`);
  await rm(tmpLink, { force: true });
  await symlink(join('versions', version), tmpLink);
  await rename(tmpLink, join(home, 'current'));
}

/** Delete all but the newest `KEEP_VERSIONS` version dirs, never `keep`. */
async function pruneVersions(versionsDir: string, keep: ReadonlySet<string>): Promise<void> {
  const names = (await readdir(versionsDir)).filter((n) => !n.startsWith('.'));
  const dated = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(versionsDir, name))).mtimeMs })),
  );
  dated.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of dated.slice(KEEP_VERSIONS)) {
    if (!keep.has(name)) await rm(join(versionsDir, name), { recursive: true, force: true });
  }
}

export const update: Command = {
  path: 'update',
  summary: 'Update Joinery to the latest release and restart the service',
  usage: 'joinery update [--yes] [--from <tarball>] [--version <x.y.z>]',
  async run(argv) {
    const parsed = parseCommand(argv, [
      { name: 'yes', type: 'boolean' },
      { name: 'from', type: 'string' },
      { name: 'version', type: 'string' },
    ]);
    if (wantsHelp(parsed)) return printLine(update.usage);

    const layout = runtimeLayout();
    if (layout.mode !== 'installed') {
      process.stderr.write('this is a source checkout — use git pull\n');
      process.exit(1);
    }
    const yes = flagBoolean(parsed.flags, 'yes');
    const from = flagString(parsed.flags, 'from');
    const requested = flagString(parsed.flags, 'version')?.replace(/^v/, '');
    if (requested !== undefined && !SEMVER.test(requested)) {
      throw new UsageError(`invalid --version "${requested}"`);
    }

    const work = await mkdtemp(join(tmpdir(), 'joinery-update-'));
    try {
      let tarball: string;
      let version = requested;
      if (from !== undefined) {
        tarball = resolve(from);
        if (!existsSync(tarball)) throw new UsageError(`no such file: ${tarball}`);
      } else {
        version ??= await latestVersion();
        if (!SEMVER.test(version)) throw new Error(`unexpected release version "${version}"`);
        if (version === layout.version) {
          printLine(`already up to date (${layout.version})`);
          return;
        }
        tarball = join(work, assetName(version));
      }

      printLine(`current   ${layout.version}`);
      printLine(`target    ${from !== undefined ? `${from} (local tarball)` : version}`);
      printLine(`install   ${join(layout.home, 'versions')}`);
      if (existsSync(plistPath())) printLine('then restart the background service');
      if (!yes && !(await confirm('Continue?'))) {
        printLine('cancelled');
        return;
      }

      if (from === undefined && version !== undefined) {
        printLine(`downloading ${assetName(version)}`);
        await download(assetUrl(version), tarball);
        const sumFile = join(work, 'tarball.sha256');
        await download(assetUrl(version, '.sha256'), sumFile);
        const expected = (await readFile(sumFile, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase();
        const actual = await sha256(tarball);
        if (expected !== actual) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
      }

      // Extract into a temp sibling of the final dir so the rename is atomic.
      const versionsDir = join(layout.home, 'versions');
      await mkdir(versionsDir, { recursive: true });
      const staging = await mkdtemp(join(versionsDir, '.staging-'));
      try {
        if ((await run(['tar', '-xzf', tarball, '-C', staging])) !== 0) throw new Error('tar extraction failed');
        const manifest = JSON.parse(await readFile(join(staging, 'release.json'), 'utf8')) as { version?: unknown };
        if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
          throw new Error('tarball has no valid release.json');
        }
        if (version !== undefined && manifest.version !== version) {
          throw new Error(`tarball is version ${manifest.version}, expected ${version}`);
        }
        version = manifest.version;
        const finalDir = join(versionsDir, version);
        await rm(finalDir, { recursive: true, force: true });
        await rename(staging, finalDir);
      } catch (err) {
        await rm(staging, { recursive: true, force: true });
        throw err;
      }

      await repointCurrent(layout.home, version);
      printLine(`updated ${layout.version} -> ${version}`);

      await pruneVersions(versionsDir, new Set([version, layout.version]));

      if (existsSync(plistPath())) {
        printLine('restarting service');
        if ((await run(['launchctl', 'kickstart', '-k', serviceTarget()])) !== 0) {
          printLine('could not restart the service; run `joinery service install`');
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
};
