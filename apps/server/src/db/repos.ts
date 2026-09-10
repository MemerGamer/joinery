/**
 * `repo` — a registered local clone, keyed by its canonical root path (§3, §4).
 */
import { repo } from '@review/core/db';
import type { Repo } from '@review/core';
import { repoId } from '@review/core';
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';

function toRepo(row: typeof repo.$inferSelect): Repo {
  return {
    id: row.id,
    rootPath: row.rootPath,
    remoteOwner: row.remoteOwner,
    remoteName: row.remoteName,
    defaultBranch: row.defaultBranch,
    createdAt: row.createdAt,
  };
}

export type UpsertRepoInput = {
  readonly rootPath: string;
  readonly remoteOwner: string | null;
  readonly remoteName: string | null;
  readonly defaultBranch: string;
};

/** Add a repo, keyed by its canonical `rootPath`. Re-adding the same path updates it in place. */
export async function upsertRepo(db: Db, input: UpsertRepoInput): Promise<Repo> {
  const id = repoId();
  const rows = await db
    .insert(repo)
    .values({
      id,
      rootPath: input.rootPath,
      remoteOwner: input.remoteOwner,
      remoteName: input.remoteName,
      defaultBranch: input.defaultBranch,
    })
    .onConflictDoUpdate({
      target: repo.rootPath,
      set: {
        remoteOwner: input.remoteOwner,
        remoteName: input.remoteName,
        defaultBranch: input.defaultBranch,
      },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) throw new Error('upsertRepo: insert returned no row');
  return toRepo(row);
}

export async function listRepos(db: Db): Promise<Repo[]> {
  const rows = await db.select().from(repo);
  return rows.map(toRepo);
}

export async function getRepoById(db: Db, id: string): Promise<Repo | null> {
  const rows = await db.select().from(repo).where(eq(repo.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toRepo(row);
}

export async function getRepoByPath(db: Db, rootPath: string): Promise<Repo | null> {
  const rows = await db.select().from(repo).where(eq(repo.rootPath, rootPath)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toRepo(row);
}
