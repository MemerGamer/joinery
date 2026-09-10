/**
 * Resolves the on-disk layout of the `data/` directory (SPEC §3).
 *
 * Everything lives under `data/` **inside the app**, never in a user
 * dot-folder, overridable with `REVIEW_DATA_DIR`:
 *
 * ```
 * data/
 *   state.sqlite
 *   token                    bearer token, mode 0600
 *   worktrees/<repo>/<sha>-<branch>/
 *   logs/
 *   cache/
 * ```
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** The app root: two levels up from `apps/server/src/db`. */
const APP_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

export type DataPaths = {
  readonly root: string;
  readonly dbFile: string;
  readonly tokenFile: string;
  readonly worktreesDir: string;
  readonly logsDir: string;
  readonly cacheDir: string;
};

/** Resolve the data directory. Does not touch the filesystem. */
export function resolveDataPaths(): DataPaths {
  const root = resolve(process.env['REVIEW_DATA_DIR']?.trim() || join(APP_ROOT, 'data'));
  return {
    root,
    dbFile: join(root, 'state.sqlite'),
    tokenFile: join(root, 'token'),
    worktreesDir: join(root, 'worktrees'),
    logsDir: join(root, 'logs'),
    cacheDir: join(root, 'cache'),
  };
}

/** Create the directory tree on first use. Idempotent. */
export async function ensureDataDirs(paths: DataPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.worktreesDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
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
