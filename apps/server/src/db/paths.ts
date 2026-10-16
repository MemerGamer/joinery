/**
 * Resolves the on-disk layout of the data directory: the repo's `data/` in
 * dev, `~/.joinery/data` when installed (see `runtime.ts`), overridable with
 * `JOINERY_DATA_DIR`:
 *
 * ```
 * data/
 *   state.sqlite
 *   token                    bearer token, mode 0600
 *   worktrees/<repo>/<sha>-<branch>/
 *   logs/
 * ```
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirRoot } from '../runtime.ts';

export type DataPaths = {
  readonly root: string;
  readonly dbFile: string;
  readonly tokenFile: string;
  readonly worktreesDir: string;
  readonly logsDir: string;
};

/** Resolve the data directory. Does not touch the filesystem. */
export function resolveDataPaths(): DataPaths {
  const root = dataDirRoot();
  return {
    root,
    dbFile: join(root, 'state.sqlite'),
    tokenFile: join(root, 'token'),
    worktreesDir: join(root, 'worktrees'),
    logsDir: join(root, 'logs'),
  };
}

/** Create the directory tree on first use. Idempotent. */
export async function ensureDataDirs(paths: DataPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.worktreesDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate the bearer token if absent and write it with mode 0600. Returns
 * the token either way. Idempotent — an existing token is left untouched.
 */
export async function ensureToken(paths: DataPaths): Promise<string> {
  if (await exists(paths.tokenFile)) {
    await chmod(paths.tokenFile, 0o600);
    return (await readFile(paths.tokenFile, 'utf8')).trim();
  }
  const token = randomBytes(32).toString('hex');
  await writeFile(paths.tokenFile, token, { mode: 0o600 });
  await chmod(paths.tokenFile, 0o600);
  return token;
}

/** Read the bearer token from `data/token`. Throws if it has not been created yet. */
export async function readToken(paths: DataPaths = resolveDataPaths()): Promise<string> {
  return (await readFile(paths.tokenFile, 'utf8')).trim();
}

/** Resolve paths, create the tree, and ensure the token exists — the one-shot setup call. */
export async function initDataDir(): Promise<DataPaths> {
  const paths = resolveDataPaths();
  await ensureDataDirs(paths);
  await ensureToken(paths);
  return paths;
}
