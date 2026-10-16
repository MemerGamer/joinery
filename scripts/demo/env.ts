/**
 * Environment for every process that runs the demo server (seed + capture):
 *  - a demo-only global gitconfig (reviewer identity "John Doe", and
 *    `insteadOf` rewrites so the repos' fake github.com remotes resolve to
 *    local bare clones: nothing ever touches the network),
 *  - a fake `gh` first on PATH (scripts/demo/bin/gh) answering with canned JSON.
 * The real global git config is never read or changed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REMOTE_OWNER = 'acme';
export const DEMO_LOGIN = 'johndoe';

export function writeDemoGitConfig(root: string, repoDirs: readonly string[]): string {
  mkdirSync(root, { recursive: true });
  const file = join(root, 'gitconfig');
  const rewrites = repoDirs
    .map(
      (d) =>
        `[url "file://${join(root, 'remotes', `${d}.git`)}"]\n\tinsteadOf = https://github.com/${REMOTE_OWNER}/${d}.git\n`,
    )
    .join('');
  writeFileSync(file, `[user]\n\tname = John Doe\n\temail = john.doe@example.com\n[init]\n\tdefaultBranch = main\n${rewrites}`);
  return file;
}

export function demoEnv(root: string): Record<string, string> {
  const bin = join(import.meta.dirname, 'bin');
  return {
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    JOINERY_DEMO_LOGIN: DEMO_LOGIN,
  };
}
