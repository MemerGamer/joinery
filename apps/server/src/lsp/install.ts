/**
 * One-click installs of the preferred language servers, for Settings →
 * Integrations. Each lands in Joinery's own data directory
 * (`data/lsp/servers/<id>/`): no package manager, no sudo, nothing outside
 * `~/.joinery`, and gone with "Remove". A server the user installed
 * themselves (in the repo or on PATH) still wins over these.
 *
 * - tsrs: its npm platform package (`@tsrs/<platform>`) is self-contained, a
 *   native binary with TypeScript's `lib.*.d.ts` beside it; no Node needed.
 *   Verified against the registry's sha512 `integrity`.
 * - PHPantom: the GitHub release archive for this platform, one static
 *   binary. Verified against the release asset's sha256 `digest`.
 *
 * The archive is unpacked into a staging directory and swapped in whole, so
 * a failed or interrupted install never leaves a half-written server behind.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstallableServer, LspLanguage } from '@joinery/core';
import { resolveDataPaths } from '../db/paths.ts';

const BINARY: Record<InstallableServer, string> = { tsrs: 'tsrs', phpantom: 'phpantom_lsp' };

const TSRS_PACKAGE: Partial<Record<string, string>> = {
  'darwin-arm64': '@tsrs/darwin-arm64',
  'linux-arm64': '@tsrs/linux-arm64-gnu',
  'linux-x64': '@tsrs/linux-x64-gnu',
};

const PHPANTOM_TARGET: Partial<Record<string, string>> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};

const PLATFORM = `${process.platform}-${process.arch}`;

function serversDir(): string {
  return join(resolveDataPaths().root, 'lsp', 'servers');
}

/** Where a managed install's binary lives, whether or not it's there. */
export function managedBinary(id: InstallableServer): string {
  return join(serversDir(), id, BINARY[id]);
}

/** What the install button offers for `language` on this machine; null when there's no build for it. */
export function installableFor(language: LspLanguage): InstallableServer | null {
  if (language === 'typescript') return TSRS_PACKAGE[PLATFORM] !== undefined ? 'tsrs' : null;
  return PHPANTOM_TARGET[PLATFORM] !== undefined ? 'phpantom' : null;
}

export async function managedVersion(id: InstallableServer): Promise<string | null> {
  if (!existsSync(managedBinary(id))) return null;
  return (await readFile(join(serversDir(), id, 'version'), 'utf8').catch(() => '')).trim() || 'unknown';
}

type Download = { url: string; version: string; verify: (bytes: Uint8Array) => boolean; stripComponents: number };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'joinery' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

async function tsrsDownload(): Promise<Download> {
  const pkg = TSRS_PACKAGE[PLATFORM];
  if (pkg === undefined) throw new Error(`tsrs has no build for ${PLATFORM}`);
  const meta = await getJson<{ version: string; dist: { tarball: string; integrity: string } }>(
    `https://registry.npmjs.org/${pkg}/latest`,
  );
  const [algorithm, expected] = meta.dist.integrity.split('-', 2);
  if (algorithm !== 'sha512' || expected === undefined) throw new Error(`unexpected integrity "${meta.dist.integrity}"`);
  return {
    url: meta.dist.tarball,
    version: meta.version,
    verify: (bytes) => createHash('sha512').update(bytes).digest('base64') === expected,
    // npm tarballs keep everything under `package/`.
    stripComponents: 1,
  };
}

async function phpantomDownload(): Promise<Download> {
  const target = PHPANTOM_TARGET[PLATFORM];
  if (target === undefined) throw new Error(`PHPantom has no build for ${PLATFORM}`);
  const release = await getJson<{
    tag_name: string;
    assets: { name: string; browser_download_url: string; digest?: string | null }[];
  }>('https://api.github.com/repos/PHPantom-dev/phpantom_lsp/releases/latest');
  const asset = release.assets.find((a) => a.name === `phpantom_lsp-${target}.tar.gz`);
  if (asset === undefined) throw new Error(`release ${release.tag_name} has no ${target} build`);
  const expected = asset.digest?.startsWith('sha256:') === true ? asset.digest.slice('sha256:'.length) : null;
  if (expected === null) throw new Error(`release ${release.tag_name} publishes no checksum for ${asset.name}`);
  return {
    url: asset.browser_download_url,
    version: release.tag_name,
    verify: (bytes) => createHash('sha256').update(bytes).digest('hex') === expected,
    stripComponents: 0,
  };
}

const installing = new Map<InstallableServer, Promise<{ version: string; path: string }>>();

/** Installs (or updates to) the latest release; concurrent calls share one install. */
export function installServer(id: InstallableServer): Promise<{ version: string; path: string }> {
  const running = installing.get(id);
  if (running !== undefined) return running;
  const promise = install(id).finally(() => installing.delete(id));
  installing.set(id, promise);
  return promise;
}

async function install(id: InstallableServer): Promise<{ version: string; path: string }> {
  const download = id === 'tsrs' ? await tsrsDownload() : await phpantomDownload();
  const res = await fetch(download.url, { headers: { 'user-agent': 'joinery' } });
  if (!res.ok) throw new Error(`download failed: ${download.url} answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!download.verify(bytes)) throw new Error(`checksum mismatch for ${download.url}`);

  const root = serversDir();
  const staging = join(root, `.${id}-${randomBytes(4).toString('hex')}`);
  const final = join(root, id);
  await mkdir(staging, { recursive: true });
  try {
    const archive = join(staging, '.archive.tar.gz');
    await writeFile(archive, bytes);
    const tar = Bun.spawn(['tar', '-xzf', archive, '-C', staging, `--strip-components=${download.stripComponents}`], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
    if (code !== 0) throw new Error(`could not unpack ${download.url}: ${stderr.trim()}`);
    await rm(archive);
    const binary = join(staging, BINARY[id]);
    if (!existsSync(binary)) throw new Error(`${download.url} has no ${BINARY[id]} in it`);
    await chmod(binary, 0o755);
    await writeFile(join(staging, 'version'), `${download.version}\n`);
    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  return { version: download.version, path: managedBinary(id) };
}

export async function removeServer(id: InstallableServer): Promise<void> {
  await rm(join(serversDir(), id), { recursive: true, force: true });
}
