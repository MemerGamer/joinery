/**
 * Stale-while-revalidate, persisted in `cache_entry` so it survives
 * restarts — for the few answers that aren't review or repo state (who `me`
 * is). Review and repo state is the engine's (`engine/reviewState.ts`,
 * `engine/repoPoller.ts`), stored in its own tables and never cached here.
 *
 * - Fresh (younger than `staleAfterMs`): answered from memory.
 * - Stale, or only on disk: answered at once, and one background load is
 *   started; when it lands with a different value, `onUpdated` fires so the
 *   caller can publish `topic.changed` and screens re-read.
 * - Nothing stored yet, or `refresh: true`: waits for the load.
 * - Loads are deduped per key (a `refresh` joins one already in flight) and
 *   capped at `concurrency` per cache, so a hundred stale reviews don't
 *   spawn a hundred `git`s at once.
 * - `keepPrevious(next, previous)` lets a cache refuse a worse answer: `gh`
 *   going offline keeps the last known pulls rather than none.
 * - Stored keys carry `version`: bumping it when `T`'s shape changes makes
 *   old rows unreachable instead of misread; `startCacheEntryPrune` deletes
 *   them, along with rows for reviews/repos nobody asks about anymore.
 */
import PQueue from 'p-queue';
import { getCacheEntry, pruneCacheEntries, putCacheEntry, type Db } from './db/index.ts';

export type StoredCacheDeps = {
  readonly db: Db;
  /** Called after a background load changed a value. */
  readonly onUpdated?: () => void;
};

export type StoredCacheOptions<T> = {
  /** Prefix for this cache's `cache_entry` keys. */
  readonly namespace: string;
  /** Bump whenever the stored shape of `T` changes. */
  readonly version: number;
  readonly staleAfterMs: number;
  readonly concurrency?: number;
  readonly keepPrevious?: (next: T, previous: T) => boolean;
};

export type StoredCache<T> = {
  get(deps: StoredCacheDeps, key: string, load: () => Promise<T>, options?: { refresh?: boolean }): Promise<T>;
  /** Forget every in-memory and in-flight entry (stored rows stay). */
  clear(): void;
};

type Entry<T> = {
  fetchedAt: number;
  value: T;
  /** `JSON.stringify(value)`, kept to compare and store without re-serializing. */
  json: string;
};

/** Every cache made by `createStoredCache`, so the settings page's "Clear caches" can reach them all. */
const allCaches = new Set<StoredCache<unknown>>();

/** Forget every cache's in-memory entries, for when their stored rows have just been deleted. */
export function clearAllStoredCaches(): void {
  for (const cache of allCaches) cache.clear();
}

export function createStoredCache<T>(options: StoredCacheOptions<T>): StoredCache<T> {
  const memory = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<T>>();
  const queue = new PQueue({ concurrency: options.concurrency ?? Number.POSITIVE_INFINITY });
  const storageKey = (key: string) => `${options.namespace}@${String(options.version)}:${key}`;

  /** The memory entry, else the stored row (loaded into memory), else null. */
  async function loadEntry(db: Db, key: string): Promise<Entry<T> | null> {
    const cached = memory.get(key);
    if (cached !== undefined) return cached;
    try {
      const stored = await getCacheEntry(db, storageKey(key));
      if (stored === null) return null;
      // A load may have landed while the row was being read; it wins.
      const raced = memory.get(key);
      if (raced !== undefined) return raced;
      const entry = { fetchedAt: stored.fetchedAt, value: JSON.parse(stored.value) as T, json: stored.value };
      memory.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  function fetchValue(deps: StoredCacheDeps, key: string, load: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const promise = queue.add(async () => {
      const value = await load();
      const fetchedAt = Date.now();
      const previous = memory.get(key);
      if (previous !== undefined && options.keepPrevious?.(value, previous.value) === true) {
        // Keep the last good answer, but don't retry on every request.
        previous.fetchedAt = fetchedAt;
        return previous.value;
      }
      const json = JSON.stringify(value);
      memory.set(key, { fetchedAt, value, json });
      await putCacheEntry(deps.db, storageKey(key), { value: json, fetchedAt }).catch(() => {});
      if (previous !== undefined && previous.json !== json) deps.onUpdated?.();
      return value;
    });
    inFlight.set(key, promise);
    // Settled callbacks always run after the `set` above, and only remove our
    // own entry (`clear()` may have let a newer load take the key).
    const settle = (): void => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    promise.then(settle, settle);
    return promise;
  }

  const cache: StoredCache<T> = {
    async get(deps, key, load, getOptions) {
      if (getOptions?.refresh === true) return fetchValue(deps, key, load);

      const entry = await loadEntry(deps.db, key);
      if (entry === null) return fetchValue(deps, key, load);
      if (Date.now() - entry.fetchedAt >= options.staleAfterMs) {
        fetchValue(deps, key, load).catch(() => {});
      }
      return entry.value;
    },
    clear() {
      memory.clear();
      inFlight.clear();
    },
  };
  allCaches.add(cache as StoredCache<unknown>);
  return cache;
}

/**
 * Deletes `cache_entry` rows not refreshed in `maxAgeMs` (default 30 days),
 * now and then daily. Every read of a live key rewrites its row, so what
 * ages out is a deleted or long-archived review, a removed repo, or a
 * superseded `version` — each costing at most one blocking load if asked
 * for again. Returns the stop function.
 */
export function startCacheEntryPrune(
  db: Db,
  options: { readonly maxAgeMs?: number; readonly intervalMs?: number } = {},
): () => void {
  const maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const run = (): void => {
    pruneCacheEntries(db, Date.now() - maxAgeMs)
      .then((removed) => {
        if (removed > 0) console.log(`[cache] pruned ${String(removed)} stale entr${removed === 1 ? 'y' : 'ies'}`);
      })
      .catch((err: unknown) => console.log(`[cache] prune failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? 24 * 60 * 60 * 1000);
  return () => clearInterval(timer);
}
