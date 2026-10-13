import { afterAll, describe, expect, it } from 'bun:test';
import { buildFileList } from '../../src/git/filelist.ts';
import { mergeBase } from '../../src/git/repo.ts';
import { gitCommit, initRepo, makeTempDir, removeTempDir, runGit, writeRepoFile } from './helpers.ts';

describe('buildFileList', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => removeTempDir(d)));
  });

  it('working revision: an untracked file is synthesized as an add-diff', async () => {
    const dir = await makeTempDir('joinery-filelist-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'README.md', 'hello\n');
    const base = gitCommit(dir, 'initial');
    await writeRepoFile(dir, 'untracked.txt', 'brand new content\n');

    const files = await buildFileList({ cwd: dir, revision: 'working', baseSha: base });
    const entry = files.find((f) => f.path === 'untracked.txt');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('added');
    expect(entry?.oldBlob).toBe('0'.repeat(40));
    // The worktree blob must be a real, computed hash (via hash-object),
    // not left as all-zeros.
    expect(entry?.newBlob).toMatch(/^[0-9a-f]{40}$/u);
    expect(entry?.newBlob).not.toBe('0'.repeat(40));
  });

  it('working revision: a dirty tracked file gets a real worktree-side hash, not all-zeros', async () => {
    const dir = await makeTempDir('joinery-filelist-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'original\n');
    const base = gitCommit(dir, 'initial');
    await writeRepoFile(dir, 'a.txt', 'changed content\n');

    const files = await buildFileList({ cwd: dir, revision: 'working', baseSha: base });
    const entry = files.find((f) => f.path === 'a.txt');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('modified');
    expect(entry?.newBlob).toMatch(/^[0-9a-f]{40}$/u);
    expect(entry?.newBlob).not.toBe('0'.repeat(40));
  });

  it('a rename carries oldPath', async () => {
    const dir = await makeTempDir('joinery-filelist-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'old-name.txt', 'stable content that is long enough to be detected as a rename\n');
    const base = gitCommit(dir, 'initial');
    runGit(dir, ['mv', 'old-name.txt', 'new-name.txt']);
    const head = gitCommit(dir, 'rename');

    const files = await buildFileList({ cwd: dir, revision: 'head', baseSha: base, targetSha: head });
    const entry = files.find((f) => f.path === 'new-name.txt');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('renamed');
    expect(entry?.oldPath).toBe('old-name.txt');
  });

  it('working revision diffs from the merge-base, not HEAD: a committed change stays visible', async () => {
    const dir = await makeTempDir('joinery-filelist-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const base = gitCommit(dir, 'initial');
    await writeRepoFile(dir, 'a.txt', 'v2\n');
    gitCommit(dir, 'agent commit'); // still on the same branch, base unchanged

    const files = await buildFileList({ cwd: dir, revision: 'working', baseSha: base });
    const entry = files.find((f) => f.path === 'a.txt');
    // Even though the change is now committed (HEAD moved), `working` still
    // shows it, because it diffs from merge-base(default, working) rather
    // than from HEAD.
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('modified');
  });

  it('commit revisions never touch the filesystem (no worktree file needs to exist)', async () => {
    const dir = await makeTempDir('joinery-filelist-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'v1\n');
    const base = gitCommit(dir, 'initial');
    await writeRepoFile(dir, 'a.txt', 'v2\n');
    const head = gitCommit(dir, 'v2 commit');
    // Now delete the file from the worktree entirely; the commit-based diff
    // must still work since it reads purely from the object store.
    await writeRepoFile(dir, 'a.txt', '');
    runGit(dir, ['checkout', '--', 'a.txt']); // restore, but prove the point below first
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(dir, 'a.txt'));

    const files = await buildFileList({ cwd: dir, revision: 'head', baseSha: base, targetSha: head });
    const entry = files.find((f) => f.path === 'a.txt');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('modified');
  });
});

describe('merge-base 3-dot behaviour', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => removeTempDir(d)));
  });

  it('a diverged local head does not show up as deletions in the pr-vs-base diff', async () => {
    const dir = await makeTempDir('joinery-filelist-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'shared.txt', 'base content\n');
    const base = gitCommit(dir, 'initial'); // this is main/default

    // Reviewer's own local commit (their unpushed work).
    await writeRepoFile(dir, 'reviewer-only.txt', 'reviewer work\n');
    gitCommit(dir, 'reviewer local commit');
    const localHead = 'HEAD';
    const localHeadSha = runGit(dir, ['rev-parse', localHead]).stdout.trim();

    // Simulate a PR branch that diverged from `base`, independent of the
    // reviewer's local commit.
    runGit(dir, ['checkout', '-q', base, '-b', 'pr-branch']);
    await writeRepoFile(dir, 'pr-only.txt', 'their pr work\n');
    gitCommit(dir, 'pr commit');
    const prSha = runGit(dir, ['rev-parse', 'HEAD']).stdout.trim();

    // merge-base(base, pr) is `base` itself here, so a straight
    // `diff base pr` is already the 3-dot comparison relative to base.
    const mb = await mergeBase(base, prSha, { cwd: dir });
    expect(mb).toBe(base);

    const files = await buildFileList({ cwd: dir, revision: 'pr', baseSha: mb ?? base, targetSha: prSha });
    const paths = files.map((f) => f.path).sort();

    // Only the PR's own file shows up; the reviewer's local-only commit
    // (on a different branch, never merged into base) must not appear as a
    // deletion the way a naive two-dot `diff localHead..pr` would show it.
    expect(paths).toEqual(['pr-only.txt']);
    expect(files.find((f) => f.path === 'reviewer-only.txt')).toBeUndefined();

    // Symmetrically, rendering `head` (the reviewer's own diverged commit)
    // against the same shared base shows only their file, not the PR's —
    // each revision is always diffed against a common ancestor rather than
    // against the other revision's tip, which is what makes 3-dot correct
    // in the diverged case.
    const headMb = await mergeBase(base, localHeadSha, { cwd: dir });
    expect(headMb).toBe(base);
    const headFiles = await buildFileList({
      cwd: dir,
      revision: 'head',
      baseSha: headMb ?? base,
      targetSha: localHeadSha,
    });
    expect(headFiles.map((f) => f.path)).toEqual(['reviewer-only.txt']);
  });
});
