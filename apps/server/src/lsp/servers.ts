/**
 * Which language server serves which file, and where its binary is.
 *
 * Settings picks per language (`choices.ts`): a server as installed on this
 * machine, the copy Joinery installed (`install.ts`), a binary at a custom
 * path, none at all, or — the default — `auto`: the fastest one found, by
 * measured speed on large repos (startup to first hover, then resident
 * memory), see the comparison in the branch notes:
 *
 * - TypeScript/JavaScript: `tsrs` (Rust port of TypeScript 7), then the Go
 *   TypeScript 7 (`tsgo`, or the `tsc` of `typescript@>=7`), then the classic
 *   `typescript-language-server` + tsserver.
 * - PHP: PHPantom, then Intelephense, then Phpactor.
 *
 * For a server "on this machine", the repo's own copy wins over PATH, so the
 * checker matches the repo's pinned version; Joinery's copy comes after both.
 *
 * A missing server is not an error anywhere: hover simply has nothing to say,
 * and Settings → Integrations lists what to install.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { installableServerSchema, LSP_SERVERS, type Integrations, type LspChoice, type LspLanguage, type LspServerId } from '@joinery/core';
import { resolveDataPaths } from '../db/paths.ts';
import { lspChoice } from './choices.ts';
import { installableFor, managedBinary, managedVersion } from './install.ts';

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

/** The executable names each server ships under. */
const BINARIES: Readonly<Record<LspServerId, readonly string[]>> = {
  tsrs: ['tsrs'],
  tsgo: ['tsgo'],
  'typescript-language-server': ['typescript-language-server'],
  phpantom: ['phpantom_lsp', 'phpantom-lsp', 'phpantom'],
  intelephense: ['intelephense'],
  phpactor: ['phpactor'],
};

/** PATH first, then where installers usually put things (a LaunchAgent's PATH is short). */
function onThisMachine(name: string): string | null {
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
    null
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

/** The repo's own copy of a TypeScript server, when `root` has one. */
function inProject(id: LspServerId, root: string): string | null {
  if (id === 'tsrs' || id === 'typescript-language-server') return projectBin(root, id);
  if (id === 'tsgo') return projectBin(root, 'tsgo') ?? ((projectTypescriptMajor(root) ?? 0) >= 7 ? projectBin(root, 'tsc') : null);
  return null;
}

/** `id` installed by the user: the repo's own copy (with a `root`), else this machine's. */
function findLocal(id: LspServerId, root: string | null): string | null {
  return (root === null ? null : inProject(id, root)) ?? BINARIES[id].map(onThisMachine).find((p) => p !== null) ?? null;
}

function findManaged(id: LspServerId): string | null {
  const installable = installableServerSchema.safeParse(id);
  if (!installable.success) return null;
  const path = managedBinary(installable.data);
  return existsSync(path) ? path : null;
}

export type Located = { readonly id: LspServerId; readonly path: string; readonly source: 'local' | 'managed' | 'custom' };

/** Where `choice` puts `language`'s server; `root` adds the repo's own copies. Null when off or not installed. */
export function locate(language: LspLanguage, choice: LspChoice, root: string | null): Located | null {
  switch (choice.source) {
    case 'off':
      return null;
    case 'custom':
      return existsSync(choice.path) ? { id: choice.server, path: choice.path, source: 'custom' } : null;
    case 'managed': {
      const path = findManaged(choice.server);
      return path === null ? null : { id: choice.server, path, source: 'managed' };
    }
    case 'local': {
      const path = findLocal(choice.server, root);
      return path === null ? null : { id: choice.server, path, source: 'local' };
    }
    case 'auto':
      for (const id of LSP_SERVERS[language]) {
        const local = findLocal(id, root);
        if (local !== null) return { id, path: local, source: 'local' };
        const managed = findManaged(id);
        if (managed !== null) return { id, path: managed, source: 'managed' };
      }
      return null;
  }
}

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

/** How to start `id` from the binary at `path`, in `root`. */
async function specFor(id: LspServerId, path: string, root: string): Promise<ServerSpec> {
  switch (id) {
    case 'tsrs':
      return { id, language: 'typescript', command: [path, '--lsp', '-stdio'] };
    case 'tsgo':
      return { id, language: 'typescript', command: [path, '--lsp', '--stdio'] };
    case 'typescript-language-server': {
      const tsserverLib = join(root, 'node_modules', 'typescript', 'lib');
      return {
        id,
        language: 'typescript',
        command: [path, '--stdio'],
        ...(existsSync(join(tsserverLib, 'tsserver.js')) ? { initializationOptions: { tsserver: { path: tsserverLib } } } : {}),
      };
    }
    case 'phpantom': {
      const env = await phpantomEnv();
      return { id, language: 'php', command: [path], ...(env !== undefined ? { env } : {}) };
    }
    case 'intelephense':
      return {
        id,
        language: 'php',
        command: [path, '--stdio'],
        initializationOptions: { storagePath: join(resolveDataPaths().root, 'lsp', 'intelephense') },
      };
    case 'phpactor':
      return { id, language: 'php', command: [path, 'language-server'] };
  }
}

export async function resolveServer(language: LspLanguage, root: string): Promise<ServerSpec | null> {
  const found = locate(language, lspChoice(language), root);
  return found === null ? null : specFor(found.id, found.path, root);
}

/** For Settings → Integrations: each language's choice, what it comes to (repo-local copies aside), and the alternatives. */
export async function installedServers(): Promise<Integrations['lsp']> {
  return Promise.all(
    (Object.keys(LSP_SERVERS) as LspLanguage[]).map(async (language) => {
      const choice = lspChoice(language);
      const found = locate(language, choice, null);
      const installable = installableFor(language);
      const version = installable === null ? null : await managedVersion(installable);
      const problem =
        found !== null || choice.source === 'auto' || choice.source === 'off'
          ? null
          : choice.source === 'custom'
            ? `Nothing at ${choice.path}`
            : choice.source === 'managed'
              ? 'Not installed by Joinery yet'
              : `${choice.server} isn't installed on this machine`;
      return {
        language,
        choice,
        server: found?.id ?? null,
        path: found?.path ?? null,
        source: found?.source ?? null,
        local: LSP_SERVERS[language].flatMap((server) => {
          const path = findLocal(server, null);
          return path === null ? [] : [{ server, path }];
        }),
        installable,
        managed: installable === null || version === null ? null : { server: installable, version },
        problem,
      };
    }),
  );
}
