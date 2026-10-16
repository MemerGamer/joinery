import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import {
  detectInProgressOperation,
  divergence,
  gitCommonDir,
  mergeBase,
  parseRemoteIdentity,
  pinReviewRef,
  remoteIdentity,
  revParse,
  unpinReviewRefs,
} from '../../src/git/repo.ts';
import { gitCommit, initRepo, makeTempDir, removeTempDir, runGit, writeRepoFile } from './helpers.ts';

describe('parseRemoteIdentity (pure)', () => {
  it('parses an SSH GitHub URL', () => {
    expect(parseRemoteIdentity('git@github.com:acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets' });
  });

  it('parses an https GitHub URL', () => {
    expect(parseRemoteIdentity('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', name: 'widgets' });
  });

  it('parses an https GitHub URL without .git suffix', () => {
    expect(parseRemoteIdentity('https://github.com/acme/widgets')).toEqual({ owner: 'acme', name: 'widgets' });
  });

  it('parses an ssh:// URL', () => {
    expect(parseRemoteIdentity('ssh://git@github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('returns nulls for an unrecognized shape', () => {
    expect(parseRemoteIdentity('not a url at all')).toEqual({ owner: null, name: null });
  });
});

describe('repo.ts against real repos', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => removeTempDir(d)));
  });

  it('mergeBase finds the common ancestor of two diverged branches', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const base = gitCommit(dir, 'initial');

    runGit(dir, ['checkout', '-q', '-b', 'branch-a']);
    await writeRepoFile(dir, 'a.txt', 'branch a\n');
    const shaA = gitCommit(dir, 'a change');

    runGit(dir, ['checkout', '-q', base, '-b', 'branch-b']);
    await writeRepoFile(dir, 'b.txt', 'branch b\n');
    const shaB = gitCommit(dir, 'b change');

    const mb = await mergeBase(shaA, shaB, { cwd: dir });
    expect(mb).toBe(base);
  });

  it('mergeBase returns null for unrelated histories', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const shaA = gitCommit(dir, 'first root');

    runGit(dir, ['checkout', '-q', '--orphan', 'unrelated']);
    runGit(dir, ['rm', '-rf', '--cached', '.']);
    await writeRepoFile(dir, 'b.txt', 'v1\n');
    const shaB = gitCommit(dir, 'second root');

    const mb = await mergeBase(shaA, shaB, { cwd: dir });
    expect(mb).toBeNull();
  });

  it('revParse resolves a ref to a full sha and returns null for garbage', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const sha = gitCommit(dir, 'initial');

    expect(await revParse('HEAD', { cwd: dir })).toBe(sha);
    expect(await revParse('does-not-exist', { cwd: dir })).toBeNull();
  });

  it('divergence reports ahead/behind between head and pr', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const base = gitCommit(dir, 'initial');

    runGit(dir, ['checkout', '-q', '-b', 'head-branch']);
    await writeRepoFile(dir, 'head-only.txt', 'x\n');
    const headSha = gitCommit(dir, 'head commit');

    runGit(dir, ['checkout', '-q', base, '-b', 'pr-branch']);
    await writeRepoFile(dir, 'pr-only-1.txt', 'x\n');
    gitCommit(dir, 'pr commit 1');
    await writeRepoFile(dir, 'pr-only-2.txt', 'x\n');
    const prSha = gitCommit(dir, 'pr commit 2');

    const div = await divergence(headSha, prSha, { cwd: dir });
    expect(div).toEqual({ ahead: 1, behind: 2 });
  });

  it('detectInProgressOperation finds a rebase in progress via marker files', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    gitCommit(dir, 'initial');

    const commonDir = await gitCommonDir({ cwd: dir });
    expect(await detectInProgressOperation(commonDir)).toBeNull();

    await mkdir(join(commonDir, 'rebase-merge'), { recursive: true });
    expect(await detectInProgressOperation(commonDir)).toBe('rebase');
  });

  it('detectInProgressOperation finds a cherry-pick via CHERRY_PICK_HEAD', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const sha = gitCommit(dir, 'initial');

    const commonDir = await gitCommonDir({ cwd: dir });
    await writeFile(join(commonDir, 'CHERRY_PICK_HEAD'), `${sha}\n`);
    expect(await detectInProgressOperation(commonDir)).toBe('cherry-pick');
  });

  it('pinReviewRef writes refs/review/<id> and unpinReviewRefs removes it', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const sha = gitCommit(dir, 'initial');

    await pinReviewRef('rev_abc123', sha, { cwd: dir });
    const resolved = runGit(dir, ['rev-parse', 'refs/review/rev_abc123']);
    expect(resolved.stdout.trim()).toBe(sha);

    await unpinReviewRefs('rev_abc123', { cwd: dir });
    const afterDelete = runGit(dir, ['rev-parse', '--verify', 'refs/review/rev_abc123']);
    expect(afterDelete.exitCode).not.toBe(0);
  });

  it('remoteIdentity returns nulls when there is no origin remote', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    gitCommit(dir, 'initial');

    const identity = await remoteIdentity({ cwd: dir });
    expect(identity).toEqual({ owner: null, name: null });
  });

  it('remoteIdentity parses a configured origin URL', async () => {
    const dir = await makeTempDir('joinery-repo-');
    dirs.push(dir);
    await initRepo(dir);
    gitCommit(dir, 'initial');
    runGit(dir, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);

    const identity = await remoteIdentity({ cwd: dir });
    expect(identity).toEqual({ owner: 'acme', name: 'widgets' });
  });
});
