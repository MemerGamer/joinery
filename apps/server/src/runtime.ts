/**
 * Where Joinery's files live, in either of its two shapes:
 *
 * - **dev**: run from a source checkout with `bun`. Resources resolve inside
 *   the repo (`apps/web/dist`, `apps/server/migrations`) and data defaults to
 *   the repo's own `data/`.
 * - **installed**: the compiled `joinery` binary unpacked from a release
 *   tarball. It is recognised by a `release.json` next to the real
 *   (symlink-resolved) executable. The install home looks like:
 *
 * ```
 * ~/.joinery/                    JOINERY_HOME overrides
 *   versions/<version>/
 *     joinery                    the compiled binary (CLI + server)
 *     release.json               { "version": "<version>" }
 *     web/                       built web app
 *     migrations/                server SQL migrations
 *   current -> versions/<version>
 *   data/                        state.sqlite, token, worktrees, logs, cache
 * ~/.local/bin/joinery -> ~/.joinery/current/joinery
 * ~/Library/LaunchAgents/dev.joinery.server.plist   runs `current/joinery serve`
 * ```
 *
 * `JOINERY_DATA_DIR` still overrides the data directory in both shapes.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The GitHub repo releases are published to and checked against. */
export const RELEASE_REPO = 'szhabolcs/joinery';

/** The launchd label of the background server service. */
export const SERVICE_LABEL = 'dev.joinery.server';

export type RuntimeLayout = {
  readonly mode: 'dev' | 'installed';
  /** Semver without a leading `v`, e.g. `0.1.0`. */
  readonly version: string;
  /** The install home (`~/.joinery`). Set in both modes so `update` can name it. */
  readonly home: string;
  readonly webDistDir: string;
  readonly migrationsDir: string;
  /** Data directory before the `JOINERY_DATA_DIR` override. */
  readonly defaultDataDir: string;
};

/** The repo root in dev: three levels up from `apps/server/src`. */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

function installHome(): string {
  return resolve(process.env['JOINERY_HOME']?.trim() || join(homedir(), '.joinery'));
}

function readVersion(file: string): string {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`no version in ${file}`);
  return parsed.version;
}

let cached: RuntimeLayout | undefined;

/** Resolve the current layout. Cheap after the first call. */
export function runtimeLayout(): RuntimeLayout {
  if (cached !== undefined) return cached;
  const home = installHome();
  let binDir: string | undefined;
  try {
    binDir = dirname(realpathSync(process.execPath));
  } catch {
    binDir = undefined;
  }
  const releaseFile = binDir === undefined ? undefined : join(binDir, 'release.json');
  if (binDir !== undefined && releaseFile !== undefined && existsSync(releaseFile)) {
    cached = {
      mode: 'installed',
      version: readVersion(releaseFile),
      home,
      webDistDir: join(binDir, 'web'),
      migrationsDir: join(binDir, 'migrations'),
      defaultDataDir: join(home, 'data'),
    };
  } else {
    cached = {
      mode: 'dev',
      version: readVersion(join(REPO_ROOT, 'package.json')),
      home,
      webDistDir: join(REPO_ROOT, 'apps', 'web', 'dist'),
      migrationsDir: join(REPO_ROOT, 'apps', 'server', 'migrations'),
      defaultDataDir: join(REPO_ROOT, 'data'),
    };
  }
  return cached;
}

/** The data directory, honouring `JOINERY_DATA_DIR`. */
export function dataDirRoot(): string {
  return resolve(process.env['JOINERY_DATA_DIR']?.trim() || runtimeLayout().defaultDataDir);
}
