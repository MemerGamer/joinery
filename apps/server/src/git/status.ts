/**
 * `git status --porcelain=v2 --branch -z --untracked-files=all`.
 *
 * The `--branch` header carries `# branch.oid`, so this call also serves as
 * the tick's `rev-parse` — one spawn instead
 * of two.
 *
 * Critically, porcelain v2 does **not** report the worktree blob hash, only
 * HEAD and index hashes:
 *
 *   1 .M N... 100644 100644 100644 <hHEAD> <hIndex> a.txt
 *                                  ^^^^^^^ ^^^^^^^^ HEAD and index only
 *
 * so a second pass (`git hash-object`, done by `filelist.ts`) is required
 * regardless to learn the worktree side.
 *
 * `S...` submodule entries and `u` unmerged entries are skipped rather than
 * fed to `hash-object`, which would choke on a directory.
 *
 * The parser below is a pure function over raw bytes, deliberately
 * independent of `run.ts`, so it is unit-testable without a repo.
 */
import { git, type GitCallOptions } from './run.ts';

export type StatusBranch = {
  /** Null for a brand new repo with no commits yet ("(initial)"). */
  oid: string | null;
  /** Null when HEAD is detached. */
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

export type OrdinaryStatusEntry = {
  kind: 'ordinary';
  path: string;
  /** The two-letter XY code, e.g. ".M", "M.", "MM", "A.", "D.". */
  xy: string;
  headBlob: string;
  indexBlob: string;
};

export type RenamedStatusEntry = {
  kind: 'renamed';
  path: string;
  oldPath: string;
  xy: string;
  headBlob: string;
  indexBlob: string;
  /** e.g. "R100" — rename/copy letter plus similarity score. */
  scoreCode: string;
};

export type UntrackedStatusEntry = {
  kind: 'untracked';
  path: string;
};

export type StatusEntry = OrdinaryStatusEntry | RenamedStatusEntry | UntrackedStatusEntry;

export type ParsedStatus = {
  branch: StatusBranch;
  entries: StatusEntry[];
};

/** Splits raw `-z` output on NUL bytes into decoded records, dropping a trailing empty record. */
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

/** Splits `str` into `n` single-space-delimited fields, then the remainder as one final field. */
function splitFixedFields(str: string, n: number): string[] {
  const fields: string[] = [];
  let rest = str;
  for (let i = 0; i < n; i++) {
    const idx = rest.indexOf(' ');
    if (idx === -1) {
      fields.push(rest);
      rest = '';
    } else {
      fields.push(rest.slice(0, idx));
      rest = rest.slice(idx + 1);
    }
  }
  fields.push(rest);
  return fields;
}

function parseBranchHeader(branch: StatusBranch, record: string): void {
  const body = record.slice('# '.length);
  if (body.startsWith('branch.oid ')) {
    const value = body.slice('branch.oid '.length);
    branch.oid = value === '(initial)' ? null : value;
  } else if (body.startsWith('branch.head ')) {
    const value = body.slice('branch.head '.length);
    branch.head = value === '(detached)' ? null : value;
  } else if (body.startsWith('branch.upstream ')) {
    branch.upstream = body.slice('branch.upstream '.length);
  } else if (body.startsWith('branch.ab ')) {
    // "+<ahead> -<behind>"
    const match = /^\+(\d+) -(\d+)$/.exec(body.slice('branch.ab '.length));
    if (match !== null) {
      branch.ahead = Number(match[1]);
      branch.behind = Number(match[2]);
    }
  }
  // Unknown branch.* headers are ignored rather than rejected, so a future
  // git version adding one doesn't break parsing.
}

/**
 * Parse raw `git status --porcelain=v2 --branch -z --untracked-files=all`
 * output. Pure: no I/O, unit-testable over recorded bytes.
 */
export function parsePorcelainStatusV2(bytes: Uint8Array): ParsedStatus {
  const records = splitNulRecords(bytes);
  const branch: StatusBranch = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  const entries: StatusEntry[] = [];

  let i = 0;
  while (i < records.length) {
    const record = records[i];
    if (record === undefined || record === '') {
      i++;
      continue;
    }

    if (record.startsWith('# ')) {
      parseBranchHeader(branch, record);
      i++;
      continue;
    }

    if (record.startsWith('1 ')) {
      // "1 XY sub mH mI mW hH hI <path>"
      const fields = splitFixedFields(record.slice('1 '.length), 7);
      const xy = fields[0] ?? '';
      const sub = fields[1] ?? '';
      const headBlob = fields[5] ?? '';
      const indexBlob = fields[6] ?? '';
      const path = fields[7] ?? '';
      if (sub.startsWith('S')) {
        i++;
        continue; // submodule — skip rather than feed to hash-object
      }
      entries.push({ kind: 'ordinary', path, xy, headBlob, indexBlob });
      i++;
      continue;
    }

    if (record.startsWith('2 ')) {
      // "2 XY sub mH mI mW hH hI X<score> <path>" then origPath as the NEXT record.
      const fields = splitFixedFields(record.slice('2 '.length), 8);
      const xy = fields[0] ?? '';
      const sub = fields[1] ?? '';
      const headBlob = fields[5] ?? '';
      const indexBlob = fields[6] ?? '';
      const scoreCode = fields[7] ?? '';
      const path = fields[8] ?? '';
      const oldPathRecord = records[i + 1];
      i += 2;
      if (sub.startsWith('S') || oldPathRecord === undefined) {
        continue;
      }
      entries.push({ kind: 'renamed', path, oldPath: oldPathRecord, xy, headBlob, indexBlob, scoreCode });
      continue;
    }

    if (record.startsWith('u ')) {
      // Unmerged entry — skip rather than feed to hash-object.
      i++;
      continue;
    }

    if (record.startsWith('? ')) {
      entries.push({ kind: 'untracked', path: record.slice('? '.length) });
      i++;
      continue;
    }

    if (record.startsWith('! ')) {
      // Ignored entry (only present with --ignored, which we don't pass) — skip.
      i++;
      continue;
    }

    // Unknown record kind: skip defensively rather than throw, so a future
    // git version adding a new record kind degrades gracefully.
    i++;
  }

  return { branch, entries };
}

/** Run `git status --porcelain=v2 --branch -z --untracked-files=all` and parse it. */
export async function readStatus(options: GitCallOptions): Promise<ParsedStatus> {
  const result = await git(
    ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
    options,
  );
  if (result.exitCode !== 0) {
    throw new Error(`git status failed (${String(result.exitCode)}): ${result.stderr}`);
  }
  return parsePorcelainStatusV2(result.stdout);
}
