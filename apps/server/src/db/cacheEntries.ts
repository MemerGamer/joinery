/**
 * `cache_entry` — last known answers for things computed from git or `gh`,
 * stored as JSON. The values are opaque here; `../storedCache.ts` owns their
 * shape and freshness.
 */
import { cacheEntry } from '@joinery/core/db';
import { eq, lt } from 'drizzle-orm';
import type { Db } from './client.ts';

export type CacheEntry = {
  readonly value: string;
  readonly fetchedAt: number;
};

export async function getCacheEntry(db: Db, key: string): Promise<CacheEntry | null> {
  const rows = await db.select().from(cacheEntry).where(eq(cacheEntry.key, key)).limit(1);
  const row = rows[0];
  return row === undefined ? null : { value: row.value, fetchedAt: row.fetchedAt };
}

export async function putCacheEntry(db: Db, key: string, entry: CacheEntry): Promise<void> {
  await db
    .insert(cacheEntry)
    .values({ key, ...entry })
    .onConflictDoUpdate({ target: cacheEntry.key, set: entry });
}

/** Deletes rows last written before `cutoff` (epoch ms); returns how many. */
export async function pruneCacheEntries(db: Db, cutoff: number): Promise<number> {
  const rows = await db.delete(cacheEntry).where(lt(cacheEntry.fetchedAt, cutoff)).returning({ key: cacheEntry.key });
  return rows.length;
}
