/**
 * "Who am I" for the web UI's greeting and for `reviewRequested`: the local
 * git identity plus the `gh` login, each
 * resolved once and cached for the process lifetime. A failed resolution is
 * NOT cached — the next call tries again — but a successful one is, so a
 * `gh` hiccup on startup doesn't wedge the login in `null` forever while
 * still keeping the common case (both resolve fine, immediately) free after
 * the first call.
 */
import { git, bytesToText } from './run.ts';

let cachedName: string | null = null;
let nameResolved = false;
let cachedLogin: string | null = null;
let loginResolved = false;

async function resolveName(cwd: string): Promise<string | null> {
  const result = await git(['config', '--get', 'user.name'], { cwd });
  if (result.exitCode !== 0) return null;
  const name = bytesToText(result.stdout).trim();
  return name === '' ? null : name;
}

async function resolveLogin(cwd: string): Promise<string | null> {
  let proc;
  try {
    proc = Bun.spawn(['gh', 'api', 'user', '--jq', '.login'], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return null;
  }
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const login = stdout.trim();
  return login === '' ? null : login;
}

export type Me = {
  name: string | null;
  login: string | null;
};

/**
 * `cwd` is the first registered repo's root, or `process.cwd()` when there
 * isn't one yet. Never throws: a missing `git config user.name` or a
 * missing/unauthenticated `gh` just means that half of `Me` is `null`.
 */
export async function getMe(cwd: string | null): Promise<Me> {
  const effectiveCwd = cwd ?? process.cwd();
  if (!nameResolved) {
    const name = await resolveName(effectiveCwd);
    if (name !== null) {
      cachedName = name;
      nameResolved = true;
    }
  }
  if (!loginResolved) {
    const login = await resolveLogin(effectiveCwd);
    if (login !== null) {
      cachedLogin = login;
      loginResolved = true;
    }
  }
  return { name: cachedName, login: cachedLogin };
}

/**
 * Synchronous read of whatever `gh` login `getMe` has already resolved (or
 * `null` if it hasn't resolved one yet). Lets `github.ts` derive
 * `reviewRequested` without awaiting `gh` a second time per PR list.
 */
export function getCachedLogin(): string | null {
  return cachedLogin;
}
