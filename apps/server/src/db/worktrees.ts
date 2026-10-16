/**
 * `agent_worktree` — a cache table keyed by `(repo_id, sha)`, not review
 * state. Deleting every row costs one rebuild before the next agent
 * run.
 */
import { agentWorktree } from '@joinery/core/db';
import { and, eq, lt } from 'drizzle-orm';
import type { Db } from './client.ts';

export type AgentWorktree = {
  readonly repoId: string;
  readonly sha: string;
  readonly path: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
};

function toAgentWorktree(row: typeof agentWorktree.$inferSelect): AgentWorktree {
  return { repoId: row.repoId, sha: row.sha, path: row.path, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

export async function getWorktree(db: Db, repoId: string, sha: string): Promise<AgentWorktree | null> {
  const rows = await db
    .select()
    .from(agentWorktree)
    .where(and(eq(agentWorktree.repoId, repoId), eq(agentWorktree.sha, sha)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toAgentWorktree(row);
}

/** Record a freshly created worktree at `(repoId, sha)`. */
export async function createWorktree(db: Db, repoId: string, sha: string, path: string): Promise<AgentWorktree> {
  const rows = await db.insert(agentWorktree).values({ repoId, sha, path }).returning();
  const row = rows[0];
  if (row === undefined) throw new Error('createWorktree: insert returned no row');
  return toAgentWorktree(row);
}

/**
 * The claim-or-create lookup: if a worktree already exists for
 * `(repoId, sha)`, touch it and return its path; otherwise call `create` to
 * materialize one on disk and record it.
 */
export async function claimOrCreateWorktree(
  db: Db,
  repoId: string,
  sha: string,
  create: () => Promise<string>,
): Promise<AgentWorktree> {
  const existing = await getWorktree(db, repoId, sha);
  if (existing !== null) return touchWorktree(db, repoId, sha);

  const path = await create();
  return createWorktree(db, repoId, sha, path);
}

export async function touchWorktree(db: Db, repoId: string, sha: string): Promise<AgentWorktree> {
  const rows = await db
    .update(agentWorktree)
    .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(agentWorktree.repoId, repoId), eq(agentWorktree.sha, sha)))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`agent_worktree (${repoId}, ${sha}) not found`);
  return toAgentWorktree(row);
}

/** Worktrees whose `last_used_at` is older than `maxAgeSeconds`. */
export async function listStaleWorktrees(db: Db, maxAgeSeconds: number): Promise<AgentWorktree[]> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const rows = await db.select().from(agentWorktree).where(lt(agentWorktree.lastUsedAt, cutoff));
  return rows.map(toAgentWorktree);
}

export async function deleteWorktree(db: Db, repoId: string, sha: string): Promise<void> {
  await db.delete(agentWorktree).where(and(eq(agentWorktree.repoId, repoId), eq(agentWorktree.sha, sha)));
}

/** Every cached worktree, or only one repo's. */
export async function listWorktrees(db: Db, repoId?: string): Promise<AgentWorktree[]> {
  const rows =
    repoId === undefined
      ? await db.select().from(agentWorktree)
      : await db.select().from(agentWorktree).where(eq(agentWorktree.repoId, repoId));
  return rows.map(toAgentWorktree);
}
