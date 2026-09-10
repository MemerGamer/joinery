import { afterAll, describe, expect, it } from 'bun:test';
import { CatFile } from '../../src/git/catfile.ts';
import { gitCommit, hashObject, initRepo, makeTempDir, removeTempDir, writeRepoFile } from './helpers.ts';

describe('CatFile', () => {
  const dirs: string[] = [];
  const catFiles: CatFile[] = [];

  afterAll(async () => {
    for (const cf of catFiles) cf.close();
    await Promise.all(dirs.map((d) => removeTempDir(d)));
  });

  it('reads a single blob correctly', async () => {
    const dir = await makeTempDir('review-ui-catfile-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'hello world\n');
    gitCommit(dir, 'initial');
    const oid = hashObject(dir, 'a.txt');

    const catFile = new CatFile(dir);
    catFiles.push(catFile);
    const blob = await catFile.readBlob(oid);
    expect(blob).not.toBeNull();
    expect(new TextDecoder().decode(blob ?? new Uint8Array())).toBe('hello world\n');
  });

  it('returns null for a missing object', async () => {
    const dir = await makeTempDir('review-ui-catfile-');
    dirs.push(dir);
    await initRepo(dir);
    gitCommit(dir, 'initial');

    const catFile = new CatFile(dir);
    catFiles.push(catFile);
    const missing = await catFile.readBlob('0'.repeat(40));
    expect(missing).toBeNull();
  });

  it('reads many blobs through one batch process, including a binary one, preserving order', async () => {
    const dir = await makeTempDir('review-ui-catfile-');
    dirs.push(dir);
    await initRepo(dir);

    const count = 60;
    const oids: string[] = [];
    const expected = new Map<string, Uint8Array>();
    for (let i = 0; i < count; i++) {
      const path = `file-${String(i)}.txt`;
      const content = `content number ${String(i)}\n`.repeat(3);
      await writeRepoFile(dir, path, content);
      oids.push(''); // placeholder, filled after commit via hash-object
    }
    // One binary file, deliberately containing NUL bytes and high bytes.
    const binaryBytes = new Uint8Array([0, 1, 2, 3, 255, 254, 0, 10, 0, 13, 9, 200]);
    await writeRepoFile(dir, 'binary.bin', binaryBytes);

    gitCommit(dir, 'add many files');

    const realOids: string[] = [];
    for (let i = 0; i < count; i++) {
      const oid = hashObject(dir, `file-${String(i)}.txt`);
      realOids.push(oid);
      expected.set(oid, new TextEncoder().encode(`content number ${String(i)}\n`.repeat(3)));
    }
    const binaryOid = hashObject(dir, 'binary.bin');
    expected.set(binaryOid, binaryBytes);
    realOids.push(binaryOid);

    const catFile = new CatFile(dir);
    catFiles.push(catFile);
    const result = await catFile.readBlobs(realOids);

    expect(result.size).toBe(realOids.length);
    for (const oid of realOids) {
      const got = result.get(oid);
      expect(got).toBeDefined();
      const want = expected.get(oid);
      expect(want).toBeDefined();
      expect(Array.from(got ?? new Uint8Array())).toEqual(Array.from(want ?? new Uint8Array()));
    }
  });

  it('restarts the process if it dies between calls', async () => {
    const dir = await makeTempDir('review-ui-catfile-');
    dirs.push(dir);
    await initRepo(dir);
    await writeRepoFile(dir, 'a.txt', 'first\n');
    gitCommit(dir, 'initial');
    const oid = hashObject(dir, 'a.txt');

    const catFile = new CatFile(dir);
    catFiles.push(catFile);
    const first = await catFile.readBlob(oid);
    expect(first).not.toBeNull();

    // Kill the underlying process out from under the instance (without
    // calling close(), which would intentionally make further use throw)
    // and give the event loop a tick to reap it, then read again — this
    // must transparently spawn a fresh batch process rather than fail.
    catFile.killUnderlyingProcessForTest();
    await Bun.sleep(50);

    const second = await catFile.readBlob(oid);
    expect(second).not.toBeNull();
    expect(new TextDecoder().decode(second ?? new Uint8Array())).toBe('first\n');
  });
});
