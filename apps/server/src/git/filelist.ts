/**
 * Build the `FileList` (SPEC §5) for a revision.
 *
 * - `working` diffs from the **merge-base**, not from HEAD (SPEC §4
 *   "Following a live worktree"): `git diff <merge-base>` — committed,
 *   staged, and unstaged all show up identically, and nothing moves in the
 *   view when an agent commits. Untracked files are invisible to `git diff`
 *   entirely and are listed separately with
 *   `git ls-files --others --exclude-standard` and synthesized as adds.
 * - Commit revisions (`head`/`pr`) read entirely from the object store via
 *   `git diff base...sha` — **3-dot, always** (SPEC §4: 2-dot renders the
 *   reviewer's own unpushed commits as deletions in exactly the diverged
 *   case it would be reached for).
 * - Renames get `oldPath` filled from `git diff -M`.
 * - Binary detection comes from git's own diff detection (`--numstat`'s
 *   `-\t-` marker); `linguist-generated`/`linguist-vendored` comes from
 *   `git check-attr`.
 * - Exactly one `git hash-object` spawn completes the worktree-side blob
 *   SHAs for a `working` revision, because porcelain/diff output never
 *   reports them (SPEC §5).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NULL_BLOB, sortFileEntries, type FileEntry, type FileStatus, type Revision } from '@review/core';
import { gitOrThrow, type GitCallOptions } from './run.ts';

function splitNulRecords(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const records: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      records.push(decoder.decode(bytes.subarray(start, i)));
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    records.push(decoder.decode(bytes.subarray(start)));
  }
  return records;
}

type RawDiffEntry = {
  statusChar: string;
  oldBlob: string;
  newBlob: string;
  path: string;
  oldPath: string | null;
};

/** Parses `git diff -M --raw -z` output. Each record is `:<oldmode> <newmode> <oldsha> <newsha> <status>`. */
function parseRawDiffZ(bytes: Uint8Array): RawDiffEntry[] {
  const records = splitNulRecords(bytes);
  const entries: RawDiffEntry[] = [];
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec === undefined || rec === '') {
      i++;
      continue;
    }
    if (!rec.startsWith(':')) {
      i++;
      continue;
    }
    const meta = rec.slice(1);
    const parts = meta.split(' ');
    const oldBlob = parts[2] ?? '';
    const newBlob = parts[3] ?? '';
    const statusField = parts[4] ?? '';
    const statusChar = statusField.charAt(0);

    if (statusChar === 'R' || statusChar === 'C') {
      const oldPath = records[i + 1];
      const path = records[i + 2];
      i += 3;
      if (oldPath === undefined || path === undefined) continue;
      entries.push({ statusChar, oldBlob, newBlob, path, oldPath });
    } else {
      const path = records[i + 1];
      i += 2;
      if (path === undefined) continue;
      entries.push({ statusChar, oldBlob, newBlob, path, oldPath: null });
    }
  }
  return entries;
}

type NumstatEntry = {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

/** Parses `git diff -M --numstat -z` output into a map keyed by the (new) path. */
function parseNumstatZ(bytes: Uint8Array): Map<string, NumstatEntry> {
  const records = splitNulRecords(bytes);
  const map = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec === undefined || rec === '') {
      i++;
      continue;
    }
    const firstTab = rec.indexOf('\t');
    const secondTab = firstTab === -1 ? -1 : rec.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      i++;
      continue;
    }
    const addedText = rec.slice(0, firstTab);
    const deletedText = rec.slice(firstTab + 1, secondTab);
    const rest = rec.slice(secondTab + 1);
    const binary = addedText === '-' && deletedText === '-';
    const additions = binary ? null : Number(addedText);
    const deletions = binary ? null : Number(deletedText);
    const entry: NumstatEntry = { additions, deletions, binary };

    if (rest === '') {
      // Rename/copy: path is carried as the next one or two NUL records
      // rather than inline (mirrors --raw -z's handling).
      const next = records[i + 1];
      const nextNext = records[i + 2];
      if (nextNext !== undefined) {
        map.set(nextNext, entry);
        i += 3;
      } else if (next !== undefined) {
        map.set(next, entry);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      map.set(rest, entry);
      i += 1;
    }
  }
  return map;
}

function mapStatusChar(ch: string): FileStatus {
  switch (ch) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'M':
    case 'T':
    default:
      return 'modified';
  }
}

async function hashObjects(paths: readonly string[], options: GitCallOptions): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const stdin = paths.map((p) => `${p}\n`).join('');
  const result = await gitOrThrow(['hash-object', '--stdin-paths'], { ...options, stdin });
  const text = new TextDecoder().decode(result.stdout).trim();
  const hashes = text === '' ? [] : text.split('\n');
  const map = new Map<string, string>();
  paths.forEach((path, idx) => {
    const hash = hashes[idx];
    if (hash !== undefined) map.set(path, hash);
  });
  return map;
}

/** `git check-attr linguist-generated linguist-vendored -z --stdin`, returning the set of flagged paths. */
async function findGeneratedOrVendored(
  paths: readonly string[],
  options: GitCallOptions,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const stdin = paths.map((p) => `${p}\n`).join('');
  const result = await gitOrThrow(
    ['check-attr', 'linguist-generated', 'linguist-vendored', '-z', '--stdin'],
    { ...options, stdin },
  );
  // Output with -z is a flat stream of NUL-terminated fields, three per
  // (path, attribute) pair: path, attribute name, value.
  const fields = splitNulRecords(result.stdout);
  const flagged = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    const value = fields[i + 2];
    if (path !== undefined && (value === 'set' || value === 'true')) {
      flagged.add(path);
    }
  }
  return flagged;
}

/**
 * Untracked files never go through `git diff`, so binary-ness and line
 * counts have to be worked out directly from disk: a NUL byte in the first
 * 8000 bytes (git's own heuristic) marks it binary, otherwise additions are
 * a newline count. Missing/unreadable files degrade to `additions: null`
 * rather than throwing, since a file can vanish between `ls-files` and here.
 */
async function untrackedFileStats(
  cwd: string,
  path: string,
): Promise<{ binary: boolean; additions: number | null }> {
  try {
    const buf = await readFile(join(cwd, path));
    const sampleLen = Math.min(buf.length, 8000);
    for (let i = 0; i < sampleLen; i++) {
      if (buf[i] === 0) return { binary: true, additions: null };
    }
    if (buf.length === 0) return { binary: false, additions: 0 };
    let lines = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) lines++;
    }
    if (buf.at(-1) !== 10) lines++; // trailing partial line with no final newline
    return { binary: false, additions: lines };
  } catch {
    return { binary: false, additions: null };
  }
}

export type BuildFileListParams = {
  /** Where to run the diff: the attached worktree root for `working`, any repo dir for `head`/`pr`. */
  cwd: string;
  revision: Revision;
  baseSha: string;
  /** The commit to diff to for `head`/`pr`. Ignored (and not required) for `working`. */
  targetSha?: string;
};

/**
 * Build the sorted `FileEntry[]` for one revision. Pure I/O orchestration —
 * all the byte-level parsing is in the pure helpers above.
 */
export async function buildFileList(params: BuildFileListParams): Promise<FileEntry[]> {
  const options: GitCallOptions = { cwd: params.cwd };
  const isWorking = params.revision === 'working';
  if (!isWorking && params.targetSha === undefined) {
    throw new Error(`buildFileList: revision "${params.revision}" requires targetSha`);
  }

  // 3-dot always (SPEC §4): the ...-range syntax on the CLI performs the
  // merge-base comparison for us, but we resolve merge-base explicitly
  // upstream (repo.ts) and pass it as `baseSha` here, so a plain two-operand
  // `diff <base> <target>` already *is* the 3-dot comparison we want,
  // because `<base>` already is `merge-base(default, target)`.
  const target = isWorking ? undefined : params.targetSha;
  const diffTargetArgs = target === undefined ? [params.baseSha] : [params.baseSha, target];

  // `--abbrev=40`: `--full-index` only affects the "index" line of patch
  // *text* output and is silently ignored for `--raw`, which otherwise
  // abbreviates object ids — breaking both the NULL_BLOB comparison below
  // and cacheKey identity downstream. `--abbrev=40` is what actually forces
  // full-width ids in `--raw` output (verified against git 2.39).
  const [rawResult, numstatResult] = await Promise.all([
    gitOrThrow(['diff', '-M', '--raw', '--abbrev=40', '-z', ...diffTargetArgs], options),
    gitOrThrow(['diff', '-M', '--numstat', '-z', ...diffTargetArgs], options),
  ]);
  const rawEntries = parseRawDiffZ(rawResult.stdout);
  const numstatByPath = parseNumstatZ(numstatResult.stdout);

  let untrackedPaths: string[] = [];
  if (isWorking) {
    const lsResult = await gitOrThrow(['ls-files', '--others', '--exclude-standard', '-z'], options);
    untrackedPaths = splitNulRecords(lsResult.stdout).filter((p) => p !== '');
  }

  const entries: FileEntry[] = [];
  const pathsNeedingHash: string[] = [];

  for (const raw of rawEntries) {
    const status = mapStatusChar(raw.statusChar);
    const numstat = numstatByPath.get(raw.path);
    const entry: FileEntry = {
      path: raw.path,
      oldPath: raw.oldPath,
      status,
      oldBlob: raw.oldBlob,
      newBlob: raw.newBlob,
      binary: numstat?.binary ?? false,
      generated: false,
      additions: numstat?.additions ?? null,
      deletions: numstat?.deletions ?? null,
    };
    entries.push(entry);
    if (isWorking && status !== 'deleted' && raw.newBlob === NULL_BLOB) {
      pathsNeedingHash.push(raw.path);
    }
  }

  const untrackedStats = await Promise.all(
    untrackedPaths.map((path) => untrackedFileStats(params.cwd, path)),
  );
  untrackedPaths.forEach((path, idx) => {
    const stats = untrackedStats[idx] ?? { binary: false, additions: null };
    entries.push({
      path,
      oldPath: null,
      status: 'added',
      oldBlob: NULL_BLOB,
      newBlob: NULL_BLOB,
      binary: stats.binary,
      generated: false,
      additions: stats.additions,
      deletions: stats.binary ? null : 0,
    });
    pathsNeedingHash.push(path);
  });

  if (pathsNeedingHash.length > 0) {
    const hashes = await hashObjects(pathsNeedingHash, options);
    for (const entry of entries) {
      const hash = hashes.get(entry.path);
      if (hash !== undefined) entry.newBlob = hash;
    }
  }

  const allPaths = entries.map((e) => e.path);
  const generatedPaths = await findGeneratedOrVendored(allPaths, options);
  for (const entry of entries) {
    if (generatedPaths.has(entry.path)) entry.generated = true;
  }

  return sortFileEntries(entries);
}
