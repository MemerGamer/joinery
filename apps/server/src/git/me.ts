/**
 * "Who am I" for the web UI's greeting and for `reviewRequested`: the local
 * git identity plus the forge login, each
 * resolved once and cached for the process lifetime. A failed resolution is
 * NOT cached — the next call tries again — but a successful one is, so a
 * forge hiccup on startup doesn't wedge the login in `null` forever while
 * still keeping the common case (both resolve fine, immediately) free after
 * the first call.
 */
import type { Forge } from './forge/index.ts';
import { git, bytesToText } from './run.ts';

let cachedName: string | null = null;
let nameResolved = false;
/** Forge logins by `kind@host`: a GitHub and a GitLab repo (or two GitLab hosts) are different accounts. */
const cachedLogins = new Map<string, string>();

/** `git config user.name` as seen from `cwd` (repo-local config included); null when unset. */
export async function gitUserName(cwd: string): Promise<string | null> {
  return resolveName(cwd);
}

async function resolveName(cwd: string): Promise<string | null> {
  const result = await git(['config', '--get', 'user.name'], { cwd });
  if (result.exitCode !== 0) return null;
  const name = bytesToText(result.stdout).trim();
  return name === '' ? null : name;
}

export type Me = {
  name: string | null;
  login: string | null;
};

/**
 * `host` is the repo's origin host (part of the login cache key). `cwd` is the first registered repo's root, or `process.cwd()` when there
 * isn't one yet. Never throws: a missing `git config user.name` or a
 * missing/unauthenticated forge CLI just means that half of `Me` is `null`.
 */
export async function getMe(cwd: string | null, forge: Forge, host: string | null): Promise<Me> {
  const effectiveCwd = cwd ?? process.cwd();
  if (!nameResolved) {
    const name = await resolveName(effectiveCwd);
    if (name !== null) {
      cachedName = name;
      nameResolved = true;
    }
  }
  const key = `${forge.kind}@${host ?? ''}`;
  let login = cachedLogins.get(key) ?? null;
  if (login === null) {
    login = await forge.currentLogin(effectiveCwd);
    if (login !== null) cachedLogins.set(key, login);
  }
  return { name: cachedName, login };
}
