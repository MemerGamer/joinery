/**
 * Which language server serves which file, and where its binary is.
 *
 * Preference order is by measured speed on large repos (startup to first
 * hover, then resident memory), see the comparison in the branch notes:
 *
 * - TypeScript/JavaScript: `tsrs` (Rust port of TypeScript 7), then the Go
 *   TypeScript 7 (`tsgo`, or the `tsc` of `typescript@>=7`), then the classic
 *   `typescript-language-server` + tsserver. The project's own copy wins over
 *   PATH within each tier, so the checker matches the repo's pinned version.
 * - PHP: PHPantom, then Intelephense, then Phpactor.
 *
 * A missing server is not an error anywhere: hover simply has nothing to say,
 * and Settings → Integrations lists what to install.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { Integrations, LspLanguage, LspServerId } from '@joinery/core';
import { resolveDataPaths } from '../db/paths.ts';
import { installableFor, managedBinary, managedBinaryFor, managedVersion } from './install.ts';

export type ServerSpec = {
  readonly id: LspServerId;
  readonly language: LspLanguage;
  readonly command: readonly string[];
  readonly initializationOptions?: unknown;
  readonly env?: Readonly<Record<string, string>>;
};

const LANGUAGE_IDS: Readonly<Record<string, { language: LspLanguage; languageId: string }>> = {
  '.ts': { language: 'typescript', languageId: 'typescript' },
  '.mts': { language: 'typescript', languageId: 'typescript' },
  '.cts': { language: 'typescript', languageId: 'typescript' },
  '.tsx': { language: 'typescript', languageId: 'typescriptreact' },
  '.js': { language: 'typescript', languageId: 'javascript' },
  '.mjs': { language: 'typescript', languageId: 'javascript' },
  '.cjs': { language: 'typescript', languageId: 'javascript' },
  '.jsx': { language: 'typescript', languageId: 'javascriptreact' },
  '.php': { language: 'php', languageId: 'php' },
};

export function languageOf(path: string): { language: LspLanguage; languageId: string } | null {
  return LANGUAGE_IDS[extname(path).toLowerCase()] ?? null;
}

/**
 * PATH first, then where installers usually put things (a LaunchAgent's PATH
 * is short), then the copy Settings installed (install.ts) — the user's own
 * install always wins over Joinery's.
 */
export function findExecutable(name: string): string | null {
  const managed = managedBinaryFor(name);
  return (
    Bun.which(name) ??
    [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(homedir(), '.cargo', 'bin'),
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.bun', 'bin'),
      join(homedir(), '.npm-global', 'bin'),
      join(homedir(), '.composer', 'vendor', 'bin'),
    ]
      .map((dir) => join(dir, name))
      .find((candidate) => existsSync(candidate)) ??
    (managed !== null && existsSync(managed) ? managed : null)
  );
}

function projectBin(root: string, name: string): string | null {
  const candidate = join(root, 'node_modules', '.bin', name);
  return existsSync(candidate) ? candidate : null;
}

/** Major version of the repo's own `typescript`, or null when it has none. */
function projectTypescriptMajor(root: string): number | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')) as {
      version?: string;
    };
    const major = Number.parseInt(pkg.version ?? '', 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

function resolveTypescript(root: string): ServerSpec | null {
  const tsrs = projectBin(root, 'tsrs') ?? findExecutable('tsrs');
  if (tsrs !== null) return { id: 'tsrs', language: 'typescript', command: [tsrs, '--lsp', '-stdio'] };

  const projectTsc = (projectTypescriptMajor(root) ?? 0) >= 7 ? projectBin(root, 'tsc') : null;
  const tsgo = projectBin(root, 'tsgo') ?? projectTsc ?? findExecutable('tsgo');
  if (tsgo !== null) return { id: 'tsgo', language: 'typescript', command: [tsgo, '--lsp', '--stdio'] };

  const classic = projectBin(root, 'typescript-language-server') ?? findExecutable('typescript-language-server');
  if (classic === null) return null;
  const tsserverLib = join(root, 'node_modules', 'typescript', 'lib');
  return {
    id: 'typescript-language-server',
    language: 'typescript',
    command: [classic, '--stdio'],
    ...(existsSync(join(tsserverLib, 'tsserver.js')) ? { initializationOptions: { tsserver: { path: tsserverLib } } } : {}),
  };
}

const PHPANTOM_BINARIES = ['phpantom_lsp', 'phpantom-lsp', 'phpantom'] as const;

/**
 * Joinery only asks for hover and definition. PHPantom's default `full`
 * indexing builds a project-wide reference index neither uses (on
 * laravel/framework: ~1.3 GB resident against ~90 MB with `composer`, for the
 * same answers), and an opened file runs the external analyzers for
 * diagnostics nobody reads here.
 */
const PHPANTOM_CONFIG = `# Written by Joinery, which only asks for hover and definition.
[indexing]
strategy = "composer"

[phpstan]
command = ""

[phpcs]
command = ""

[phpmd]
command = ""

[mago]
command = ""
`;

/**
 * Unless the user keeps a global PHPantom config of their own, point it at
 * ours. A project's `.phpantom.toml` is still merged over it, key by key.
 */
async function phpantomEnv(): Promise<Record<string, string> | undefined> {
  const xdg = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  if (existsSync(join(xdg, 'phpantom_lsp', '.phpantom.toml'))) return undefined;
  const ours = join(resolveDataPaths().root, 'lsp', 'config');
  const file = join(ours, 'phpantom_lsp', '.phpantom.toml');
  if ((await readFile(file, 'utf8').catch(() => null)) !== PHPANTOM_CONFIG) {
    await mkdir(join(ours, 'phpantom_lsp'), { recursive: true });
    await writeFile(file, PHPANTOM_CONFIG);
  }
  return { XDG_CONFIG_HOME: ours };
}

async function resolvePhp(): Promise<ServerSpec | null> {
  const phpantom = PHPANTOM_BINARIES.map(findExecutable).find((p) => p !== null) ?? null;
  if (phpantom !== null) {
    const env = await phpantomEnv();
    return { id: 'phpantom', language: 'php', command: [phpantom], ...(env !== undefined ? { env } : {}) };
  }
  const intelephense = findExecutable('intelephense');
  if (intelephense !== null) {
    return {
      id: 'intelephense',
      language: 'php',
      command: [intelephense, '--stdio'],
      initializationOptions: { storagePath: join(resolveDataPaths().root, 'lsp', 'intelephense') },
    };
  }
  const phpactor = findExecutable('phpactor');
  if (phpactor !== null) return { id: 'phpactor', language: 'php', command: [phpactor, 'language-server'] };
  return null;
}

export async function resolveServer(language: LspLanguage, root: string): Promise<ServerSpec | null> {
  return language === 'php' ? resolvePhp() : resolveTypescript(root);
}

/** For Settings → Integrations: what this machine would start (repo-local copies aside), and what it could install. */
export async function installedServers(): Promise<Integrations['lsp']> {
  const ts =
    (['tsrs', 'tsgo', 'typescript-language-server'] as const)
      .map((id) => ({ id, path: findExecutable(id) }))
      .find((s) => s.path !== null) ?? null;
  const php =
    (
      [
        ['phpantom', PHPANTOM_BINARIES],
        ['intelephense', ['intelephense']],
        ['phpactor', ['phpactor']],
      ] as const
    )
      .map(([id, bins]) => ({ id, path: bins.map(findExecutable).find((p) => p !== null) ?? null }))
      .find((s) => s.path !== null) ?? null;
  return Promise.all(
    ([
      ['typescript', ts],
      ['php', php],
    ] as const).map(async ([language, found]) => {
      const installable = installableFor(language);
      const version = installable === null ? null : await managedVersion(installable);
      return {
        language,
        server: found?.id ?? null,
        path: found?.path ?? null,
        installable,
        managed:
          installable === null || version === null
            ? null
            : { server: installable, version, inUse: found?.path === managedBinary(installable) },
      };
    }),
  );
}
