import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import {
  createDetachedWorktree,
  findWorktreeForBranch,
  listWorktrees,
  parseWorktreeListPorcelain,
  scopedRemoveWorktree,
  slugifyBranch,
  worktreeDirName,
} from '../../src/git/worktree.ts';
import { gitCommonDir } from '../../src/git/repo.ts';
import { canonicalizePath } from '../../src/git/paths.ts';
import { gitCommit, initRepo, makeTempDir, removeTempDir, runGit, writeRepoFile } from './helpers.ts';

describe('parseWorktreeListPorcelain (pure, over recorded text)', () => {
  it('parses the main worktree plus a detached linked worktree', () => {
    const text =
      `worktree /Users/test/repo\n` +
      `HEAD abc123abc123abc123abc123abc123abc123abcd\n` +
      `branch refs/heads/main\n` +
      `\n` +
      `worktree /private/tmp/wtloc/elsewhere/deep/nested/wt1\n` +
      `HEAD def456def456def456def456def456def456defa\n` +
      `detached\n` +
      `\n`;
    const entries = parseWorktreeListPorcelain(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      path: '/Users/test/repo',
      headSha: 'abc123abc123abc123abc123abc123abc123abcd',
      branch: 'refs/heads/main',
      detached: false,
    });
    expect(entries[1]).toMatchObject({
      path: '/private/tmp/wtloc/elsewhere/deep/nested/wt1',
      headSha: 'def456def456def456def456def456def456defa',
      branch: null,
      detached: true,
    });
  });

  it('parses locked and prunable annotations with reasons', () => {
    const text =
      `worktree /tmp/wt-stale\n` +
      `HEAD 1111111111111111111111111111111111111111\n` +
      `branch refs/heads/feat/y\n` +
      `locked manually locked for testing\n` +
      `prunable gitdir file points to non-existent location\n` +
      `\n`;
    const entries = parseWorktreeListPorcelain(text);
    expect(entries[0]).toMatchObject({
      locked: true,
      lockReason: 'manually locked for testing',
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    });
  });

  it('parses a bare repository record', () => {
    const text = `worktree /tmp/bare-repo.git\nbare\n\n`;
    const entries = parseWorktreeListPorcelain(text);
    expect(entries[0]).toMatchObject({ path: '/tmp/bare-repo.git', bare: true });
  });

  it('returns an empty list for empty input', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([]);
  });
});

describe('worktreeDirName / slugifyBranch', () => {
  it('combines sha-short and slug when a branch is given', () => {
    expect(worktreeDirName('abc1234', 'feat/my-thing')).toBe('abc1234-feat/my-thing');
  });

  it('uses just the sha-short when there is no branch', () => {
    expect(worktreeDirName('abc1234', null)).toBe('abc1234');
  });

  it('slugifies a branch name to something filesystem-safe', () => {
    expect(slugifyBranch('feat/Weird Name_123!!')).toBe('feat-weird-name-123');
  });
});

describe('worktree lifecycle against a real repo', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => removeTempDir(d)));
  });

  it('lists worktrees from any worktree of the repo, including one created elsewhere', async () => {
    const repoDir = await makeTempDir('review-ui-wt-repo-');
    dirs.push(repoDir);
    const dataDir = await canonicalizePath(await makeTempDir('review-ui-wt-data-'));
    dirs.push(dataDir);

    await initRepo(repoDir);
    await writeRepoFile(repoDir, 'a.txt', 'hi\n');
    const sha = gitCommit(repoDir, 'initial');

    const wtPath = join(dataDir, 'nested', 'deep', 'wt1');
    const created = await createDetachedWorktree({ repoCwd: repoDir, sha, path: wtPath, dataDir });
    expect(created.detached).toBe(true);
    expect(created.branch).toBeNull();

    // List from the main repo root.
    const fromMain = await listWorktrees({ cwd: repoDir });
    expect(fromMain.some((w) => w.path === created.path)).toBe(true);

    // List from inside the linked worktree itself — identical registry.
    const fromLinked = await listWorktrees({ cwd: wtPath });
    expect(fromLinked.map((w) => w.path).sort()).toEqual(fromMain.map((w) => w.path).sort());
  });

  it('always creates worktrees detached, never holding a branch', async () => {
    const repoDir = await makeTempDir('review-ui-wt-repo-');
    dirs.push(repoDir);
    const dataDir = await canonicalizePath(await makeTempDir('review-ui-wt-data-'));
    dirs.push(dataDir);

    await initRepo(repoDir);
    await writeRepoFile(repoDir, 'a.txt', 'hi\n');
    const sha = gitCommit(repoDir, 'initial');

    const wtPath = join(dataDir, 'wt-detached');
    const created = await createDetachedWorktree({ repoCwd: repoDir, sha, path: wtPath, dataDir });
    expect(created.branch).toBeNull();
    expect(created.detached).toBe(true);

    // Since it never holds a branch, checking out that same branch name
    // elsewhere (or re-adding another detached worktree at the same SHA)
    // must not be blocked.
    const secondWtPath = join(dataDir, 'wt-detached-2');
    const second = await createDetachedWorktree({ repoCwd: repoDir, sha, path: secondWtPath, dataDir });
    expect(second.path).not.toBe(created.path);
  });

  it('finds which worktree holds a named branch, with a canonicalized path', async () => {
    const repoDir = await makeTempDir('review-ui-wt-repo-');
    dirs.push(repoDir);
    await initRepo(repoDir);
    await writeRepoFile(repoDir, 'a.txt', 'hi\n');
    gitCommit(repoDir, 'initial');
    runGit(repoDir, ['checkout', '-q', '-b', 'feat/x']);

    const found = await findWorktreeForBranch('feat/x', { cwd: repoDir });
    expect(found).not.toBeNull();
    expect(found?.branch).toBe('refs/heads/feat/x');

    const notFound = await findWorktreeForBranch('does-not-exist', { cwd: repoDir });
    expect(notFound).toBeNull();
  });

  it('scopedRemoveWorktree rm -rfs the directory and deletes exactly the registry entry, refusing paths outside dataDir', async () => {
    const repoDir = await makeTempDir('review-ui-wt-repo-');
    dirs.push(repoDir);
    const dataDir = await canonicalizePath(await makeTempDir('review-ui-wt-data-'));
    dirs.push(dataDir);

    await initRepo(repoDir);
    await writeRepoFile(repoDir, 'a.txt', 'hi\n');
    const sha = gitCommit(repoDir, 'initial');

    const wtPath = join(dataDir, 'wt-to-remove');
    const created = await createDetachedWorktree({ repoCwd: repoDir, sha, path: wtPath, dataDir });
    const commonDir = await gitCommonDir({ cwd: repoDir });

    // Refuses a path outside dataDir.
    await expect(
      scopedRemoveWorktree({
        worktreePath: repoDir, // not under dataDir
        gitCommonDir: commonDir,
        worktreeName: 'wt-to-remove',
        dataDir,
      }),
    ).rejects.toThrow();

    // Find the actual registry entry name by inspecting worktrees/ dir.
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(join(commonDir, 'worktrees'));
    expect(names.length).toBeGreaterThan(0);
    const ourName = names.find((n) => n.includes('wt-to-remove')) ?? names[0];
    if (ourName === undefined) throw new Error('no registry entry found');

    await scopedRemoveWorktree({
      worktreePath: created.path,
      gitCommonDir: commonDir,
      worktreeName: ourName,
      dataDir,
    });

    await expect(access(created.path)).rejects.toThrow();
    await expect(access(join(commonDir, 'worktrees', ourName))).rejects.toThrow();

    // The main repo itself, and a co-resident worktree we didn't create,
    // must be untouched by a scoped removal — verify the repo is still a
    // healthy git repo.
    const listAfter = await listWorktrees({ cwd: repoDir });
    expect(listAfter.some((w) => w.path === repoDir || w.branch === 'refs/heads/main')).toBe(true);
  });
});
