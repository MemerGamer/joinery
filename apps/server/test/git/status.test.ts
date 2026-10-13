import { afterAll, describe, expect, it } from 'bun:test';
import { parsePorcelainStatusV2, readStatus } from '../../src/git/status.ts';
import { gitCommit, initRepo, makeTempDir, removeTempDir, writeRepoFile } from './helpers.ts';

const NUL = '\0';

function encode(record: string): Uint8Array {
  return new TextEncoder().encode(record);
}

describe('parsePorcelainStatusV2 (pure, over recorded bytes)', () => {
  it('parses the branch header, including ahead/behind', () => {
    const raw =
      `# branch.oid abc123abc123abc123abc123abc123abc123abcd${NUL}` +
      `# branch.head main${NUL}` +
      `# branch.upstream origin/main${NUL}` +
      `# branch.ab +2 -3${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.branch).toEqual({
      oid: 'abc123abc123abc123abc123abc123abc123abcd',
      head: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
    });
    expect(parsed.entries).toEqual([]);
  });

  it('treats "(initial)" oid and "(detached)" head as null', () => {
    const raw = `# branch.oid (initial)${NUL}# branch.head (detached)${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.branch.oid).toBeNull();
    expect(parsed.branch.head).toBeNull();
  });

  it('parses an ordinary modified entry (ordinary format "1")', () => {
    // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
    const hHead = 'a'.repeat(40);
    const hIndex = 'b'.repeat(40);
    const raw = `1 .M N... 100644 100644 100644 ${hHead} ${hIndex} src/a.txt${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.entries).toEqual([
      { kind: 'ordinary', path: 'src/a.txt', xy: '.M', headBlob: hHead, indexBlob: hIndex },
    ]);
  });

  it('parses a renamed entry (format "2"), consuming the following record as oldPath', () => {
    const hHead = 'c'.repeat(40);
    const hIndex = 'd'.repeat(40);
    const raw =
      `2 R. N... 100644 100644 100644 ${hHead} ${hIndex} R100 new/path.txt${NUL}` + `old/path.txt${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.entries).toEqual([
      {
        kind: 'renamed',
        path: 'new/path.txt',
        oldPath: 'old/path.txt',
        xy: 'R.',
        headBlob: hHead,
        indexBlob: hIndex,
        scoreCode: 'R100',
      },
    ]);
  });

  it('parses an untracked entry', () => {
    const raw = `? new-file.txt${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.entries).toEqual([{ kind: 'untracked', path: 'new-file.txt' }]);
  });

  it('skips submodule entries (sub starts with S) rather than emitting them', () => {
    const hHead = 'e'.repeat(40);
    const hIndex = 'f'.repeat(40);
    const raw = `1 .M S..U 160000 160000 160000 ${hHead} ${hIndex} vendor/lib${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.entries).toEqual([]);
  });

  it('skips unmerged ("u") entries rather than feeding them to hash-object', () => {
    const h1 = '1'.repeat(40);
    const h2 = '2'.repeat(40);
    const h3 = '3'.repeat(40);
    const raw = `u UU N... 100644 100644 100644 100644 ${h1} ${h2} ${h3} conflict.txt${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.entries).toEqual([]);
  });

  it('handles a mix of headers, ordinary, rename, and untracked records in one payload', () => {
    const hHead = '1'.repeat(40);
    const hIndex = '2'.repeat(40);
    const raw =
      `# branch.oid ${'a'.repeat(40)}${NUL}` +
      `# branch.head feature${NUL}` +
      `1 M. N... 100644 100644 100644 ${hHead} ${hIndex} changed.txt${NUL}` +
      `2 R. N... 100644 100644 100644 ${hHead} ${hIndex} R095 renamed-to.txt${NUL}` +
      `renamed-from.txt${NUL}` +
      `? untracked.txt${NUL}`;
    const parsed = parsePorcelainStatusV2(encode(raw));
    expect(parsed.branch.head).toBe('feature');
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]).toMatchObject({ kind: 'ordinary', path: 'changed.txt' });
    expect(parsed.entries[1]).toMatchObject({ kind: 'renamed', path: 'renamed-to.txt', oldPath: 'renamed-from.txt' });
    expect(parsed.entries[2]).toMatchObject({ kind: 'untracked', path: 'untracked.txt' });
  });
});

describe('readStatus (integration, against a real repo)', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => removeTempDir(d)));
  });

  it('reports an untracked file and the branch oid matching HEAD', async () => {
    const dir = await makeTempDir('joinery-status-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'README.md', 'hello\n');
    const sha = gitCommit(dir, 'initial');
    await writeRepoFile(dir, 'untracked.txt', 'new content\n');

    const parsed = await readStatus({ cwd: dir });
    expect(parsed.branch.oid).toBe(sha);
    expect(parsed.branch.head).toBe('main');
    const untracked = parsed.entries.find((e) => e.kind === 'untracked');
    expect(untracked).toEqual({ kind: 'untracked', path: 'untracked.txt' });
  });

  it('does not report the worktree blob hash for a modified tracked file (only HEAD/index)', async () => {
    const dir = await makeTempDir('joinery-status-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'original\n');
    gitCommit(dir, 'initial');
    await writeRepoFile(dir, 'a.txt', 'modified\n');

    const parsed = await readStatus({ cwd: dir });
    const entry = parsed.entries.find((e) => e.kind === 'ordinary' && e.path === 'a.txt');
    expect(entry).toBeDefined();
    if (entry?.kind === 'ordinary') {
      // headBlob/indexBlob are real object ids (unchanged since last commit);
      // there is no field carrying the new worktree content's hash at all.
      expect(entry.headBlob).toMatch(/^[0-9a-f]{40}$/u);
      expect(entry.indexBlob).toMatch(/^[0-9a-f]{40}$/u);
    }
  });
});
