/**
 * Release awareness: which version is running, whether a newer GitHub
 * release exists, and kicking off `joinery update --yes`.
 *
 * The latest-release lookup is lazy (first request) and cached in memory for
 * six hours. Any failure — offline, a 404 while the repo is private, a rate
 * limit — yields `latest: null`, is logged once, and never throws.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionInfo } from '@joinery/core';
import { resolveDataPaths } from './db/paths.ts';
import { conflict } from './http/errors.ts';
import { RELEASE_REPO, runtimeLayout } from './runtime.ts';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5_000;

let latest: string | null = null;
let checkedAt = 0;
let inflight: Promise<void> | null = null;
let warned = false;
let updating = false;

/** `x.y.z` (optional leading `v`) as numbers; prereleases and anything malformed are rejected. */
function parseSemver(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

async function fetchLatest(): Promise<void> {
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'joinery' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
    latest = parseSemver(tag) === null ? null : tag;
  } catch (err) {
    latest = null;
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console -- logged once; the check is best-effort
      console.warn(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    checkedAt = Date.now();
  }
}

async function ensureChecked(force: boolean): Promise<void> {
  if (!force && checkedAt > 0 && Date.now() - checkedAt < CHECK_INTERVAL_MS) return;
  inflight ??= fetchLatest().finally(() => {
    inflight = null;
  });
  await inflight;
}

export async function getVersionInfo(refresh = false): Promise<VersionInfo> {
  const layout = runtimeLayout();
  await ensureChecked(refresh);
  return {
    current: layout.version,
    latest,
    updateAvailable: latest !== null && isNewer(latest, layout.version),
    mode: layout.mode,
    updating,
  };
}

/**
 * Spawn `joinery update --yes` detached, logging to `<data>/logs/update.log`.
 * The update restarts the LaunchAgent, which replaces this process.
 */
export function startUpdate(): void {
  if (runtimeLayout().mode !== 'installed') {
    throw conflict('updates are only available for installed builds', 'Run `git pull` in your checkout.');
  }
  if (updating) throw conflict('an update is already in progress');
  const { logsDir } = resolveDataPaths();
  mkdirSync(logsDir, { recursive: true });
  const log = openSync(join(logsDir, 'update.log'), 'a');
  updating = true;
  try {
    const child = spawn(process.execPath, ['update', '--yes'], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', () => {
      updating = false;
    });
    child.on('exit', () => {
      // Success normally means the LaunchAgent restarts us; if we're still
      // alive (started by hand), allow another attempt.
      updating = false;
    });
    child.unref();
  } catch (err) {
    updating = false;
    throw err;
  }
}
