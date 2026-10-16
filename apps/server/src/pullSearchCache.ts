/**
 * PR search results (the forge's `searchPulls`), cached in memory per
 * (normalized query, sorted repo set) for 60 s. Not persisted: unlike the
 * open-PR list, a search is typed-in and throwaway. `available: false`
 * answers aren't kept, so a CLI login takes effect on the next keystroke.
 */
import type { Repo } from '@joinery/core';
import { forgeFor, type Forge, type SearchPullsResult } from './git/forge/index.ts';

export type PullSearchResult = SearchPullsResult;

const FRESH_MS = 60_000;
const MAX_ENTRIES = 100;

const entries = new Map<string, { at: number; value: PullSearchResult }>();
const inFlight = new Map<string, Promise<PullSearchResult>>();

/** `repos` must all have a supported forge remote (`forgeFor(repo).kind !== 'none'`). */
export function searchPullsCached(query: string, repos: readonly Repo[]): Promise<PullSearchResult> {
  const normalized = query.trim().toLowerCase();
  const key = `${normalized}\0${repos.map((r) => r.id).sort().join(',')}`;
  const hit = entries.get(key);
  if (hit !== undefined && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.value);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const promise = searchForges(query.trim(), repos)
    .then((value) => {
      if (value.available) {
        entries.set(key, { at: Date.now(), value });
        if (entries.size > MAX_ENTRIES) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
      }
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** One `searchPulls` per forge among `repos`, merged; unavailable only when no forge could be asked. */
async function searchForges(query: string, repos: readonly Repo[]): Promise<PullSearchResult> {
  const byForge = new Map<Forge, { slug: string; cwd: string }[]>();
  for (const r of repos) {
    const forge = forgeFor(r);
    const group = byForge.get(forge) ?? [];
    group.push({ slug: `${r.remoteOwner ?? ''}/${r.remoteName ?? ''}`, cwd: r.rootPath });
    byForge.set(forge, group);
  }
  const results = await Promise.all([...byForge].map(([forge, group]) => forge.searchPulls(query, group)));
  if (results.length === 0) return { available: true, pulls: [] };
  const pulls = results.flatMap((r) => r.pulls);
  if (results.some((r) => r.available)) return { available: true, pulls };
  // Nothing could be asked: report the first forge's reason.
  const reason = results[0]?.unavailableReason;
  return {
    available: false,
    pulls,
    ...(reason === undefined ? {} : { unavailableReason: reason, unavailableHost: results[0]?.unavailableHost ?? null }),
  };
}
