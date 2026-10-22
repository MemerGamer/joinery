/**
 * Which language server serves which file, and where its binary is.
 *
 * Settings picks per language (`choices.ts`):
 *
 * - on: Joinery's own copy of the language's default server
 *   (`LSP_DEFAULT_SERVER`: tsrs, the Rust port of TypeScript 7, and
 *   PHPantom — the fastest to first hover and the lightest on large repos
 *   in the branch notes' comparison), installed here when turned on, or
 *   again if it has gone missing (`install.ts`);
 * - a binary at a custom path, spoken to as the server the user says it is;
 * - or none, until the user turns one on.
 *
 * A missing server is not an error anywhere: hover simply has nothing to say,
 * and Settings → Integrations says why.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { LSP_DEFAULT_SERVER, LSP_SERVERS, type Integrations, type LspLanguage, type LspServerId } from '@joinery/core';
import { resolveDataPaths } from '../db/paths.ts';
import { lspChoice } from './choices.ts';
import { installableFor, installServer, isInstalling, managedBinary, managedVersion } from './install.ts';

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

/** The binary `language`'s choice runs, installing Joinery's copy first when it's the one and missing. */
async function binaryFor(language: LspLanguage, install: boolean): Promise<{ id: LspServerId; path: string } | null> {
  const choice = lspChoice(language);
  if (choice.source === 'off') return null;
  if (choice.source === 'custom') return existsSync(choice.path) ? { id: choice.server, path: choice.path } : null;
  const id = LSP_DEFAULT_SERVER[language];
  if (installableFor(language) === null) return null;
  const path = managedBinary(id);
  if (existsSync(path)) return { id, path };
  if (!install) return null;
  await installServer(id);
  return { id, path };
}

/** How to start `language`'s server in `root`; null when it's off or can't be had. */
export async function resolveServer(language: LspLanguage, root: string): Promise<ServerSpec | null> {
  const found = await binaryFor(language, true);
  return found === null ? null : specFor(found.id, found.path, root);
}

/** For Settings → Integrations: each language's choice and what it comes to. */
export async function installedServers(): Promise<Integrations['lsp']> {
  return Promise.all(
    (Object.keys(LSP_SERVERS) as LspLanguage[]).map(async (language) => {
      const choice = lspChoice(language);
      const found = await binaryFor(language, false);
      const installable = installableFor(language);
      const version = installable === null ? null : await managedVersion(installable);
      const installing = installable !== null && isInstalling(installable);
      return {
        language,
        choice,
        server: found?.id ?? null,
        path: found?.path ?? null,
        installable,
        managed: version === null ? null : { version },
        installing,
        problem:
          choice.source === 'custom' && found === null
            ? `Nothing at ${choice.path}`
            : choice.source === 'managed' && installable === null
              ? `No ${LSP_DEFAULT_SERVER[language]} build for this machine`
              : null,
      };
    }),
  );
}
