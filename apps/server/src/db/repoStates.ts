/**
 * `repo_state` — the repo's open pulls as the engine last polled them
 * (`engine/repoPoller.ts` is the only writer).
 */
import { repoState } from '@joinery/core/db';
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';

export type StoredRepoState = {
  readonly repoId: string;
  readonly version: number;
  /** JSON `ListOpenPullsResult`; parsed by the caller, which owns the shape. */
  readonly pulls: string;
  readonly polledAt: number;
};

export async function getRepoState(db: Db, repoId: string): Promise<StoredRepoState | null> {
  const rows = await db.select().from(repoState).where(eq(repoState.repoId, repoId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : row;
}

/** Writes `pulls` as the next version; returns it. */
export async function putRepoState(db: Db, repoId: string, pulls: string, previousVersion: number | null): Promise<number> {
  const version = (previousVersion ?? 0) + 1;
  const values = { version, pulls, polledAt: Math.floor(Date.now() / 1000) };
  await db
    .insert(repoState)
    .values({ repoId, ...values })
    .onConflictDoUpdate({ target: repoState.repoId, set: values });
  return version;
}
