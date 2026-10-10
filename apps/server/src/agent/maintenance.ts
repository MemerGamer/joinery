/**
 * Housekeeping for agent runs and their worktrees.
 *
 * - `failOrphanedRuns` runs once at boot: a run still `pending`/`running`
 *   in the database belongs to a previous server process (runs execute
 *   in-process, and don't resume), so it is marked
 *   `error` rather than left looking busy forever, and any `eyes` working
 *   indicator it left on a comment is cleared.
 * - `startWorktreeSweep` keeps pruning cached agent worktrees
 *   ("agent worktrees are a cache, not state") for as long as the server
 *   runs: once at start, then on a fixed interval. A worktree unused for
 *   `maxAgeSeconds` is removed from disk, from git's registry, and from
 *   `agent_worktree`; the next run that needs it just rebuilds it.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  clearAgentReactions,
  deleteWorktree,
  getRepoById,
  listStaleWorktrees,
  listUnfinishedRuns,
  setRunError,
  setRunStatus,
  type AgentWorktree,
  type Db,
} from '../db/index.ts';
import { resolveDataPaths } from '../db/paths.ts';
import { gitCommonDir, scopedRemoveWorktree } from '../git/index.ts';

export async function failOrphanedRuns(db: Db): Promise<number> {
  const runs = await listUnfinishedRuns(db);
  for (const run of runs) {
    await setRunError(db, run.id, 'The server restarted while this run was in progress.');
    await setRunStatus(db, run.id, 'error');
  }
  await clearAgentReactions(db, 'eyes');
  return runs.length;
}

export type WorktreeSweepOptions = {
  /** Remove worktrees whose last use is older than this. Default: 7 days. */
  readonly maxAgeSeconds?: number;
  /** How often to sweep. Default: 1 hour. */
  readonly intervalMs?: number;
  readonly log?: (message: string) => void;
};

/** Starts sweeping now and on every interval; call the returned function to stop. */
export function startWorktreeSweep(db: Db, options: WorktreeSweepOptions = {}): () => void {
  const maxAgeSeconds = options.maxAgeSeconds ?? 7 * 24 * 60 * 60;
  const log = options.log ?? ((message: string) => console.log(`[worktrees] ${message}`));
  let sweeping = false;

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const worktree of await listStaleWorktrees(db, maxAgeSeconds)) {
        try {
          await removeAgentWorktree(db, worktree);
          log(`removed ${worktree.path}`);
        } catch (err) {
          log(`could not remove ${worktree.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      sweeping = false;
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), options.intervalMs ?? 60 * 60 * 1000);
  return () => clearInterval(timer);
}

async function removeAgentWorktree(db: Db, worktree: AgentWorktree): Promise<void> {
  const registry = await registryEntry(db, worktree);
  if (registry !== null) {
    await scopedRemoveWorktree({
      worktreePath: worktree.path,
      gitCommonDir: registry.gitCommonDir,
      worktreeName: registry.name,
      dataDir: resolveDataPaths().root,
    });
  }
  await deleteWorktree(db, worktree.repoId, worktree.sha);
}

/**
 * Where git registered this worktree: read from the worktree's own `.git`
 * file (`gitdir: <common>/worktrees/<name>`), which is exact even when git
 * had to suffix the name; if the directory is already gone, fall back to the
 * repo's common dir and the directory's basename (git's default name).
 * `null` when the repo itself is gone — then there's no registry to clean.
 */
async function registryEntry(db: Db, worktree: AgentWorktree): Promise<{ gitCommonDir: string; name: string } | null> {
  try {
    const text = await readFile(join(worktree.path, '.git'), 'utf8');
    const gitDir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (gitDir !== undefined) return { gitCommonDir: dirname(dirname(gitDir)), name: basename(gitDir) };
  } catch {
    // Directory already gone — fall through.
  }
  const repo = await getRepoById(db, worktree.repoId);
  if (repo === null) return null;
  try {
    return { gitCommonDir: await gitCommonDir({ cwd: repo.rootPath }), name: basename(worktree.path) };
  } catch {
    return null;
  }
}
