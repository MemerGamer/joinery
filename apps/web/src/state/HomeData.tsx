/**
 * Homebase / Explore data: repos, reviews (+ their summaries), and open
 * pulls per repo, held in a module-level store rather than React state so
 * navigating between the two screens reuses the last snapshot instead of
 * refetching. `useSyncExternalStore` is the only React-facing surface;
 * everything else here is plain module state shared by every component that
 * calls `useHomeData()`.
 */
import type { Branch, Me, Pull, Repo, Review, ReviewSummary } from '@review/core';
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { goReview } from '../lib/router.ts';
import { eventsClient } from '../lib/wsClient.ts';

export type Bucket = 'attention' | 'done';

export interface HomeReview {
  review: Review;
  summary: ReviewSummary;
  repo: Repo;
  bucket: Bucket;
}

export interface HomeSnapshot {
  repos: Repo[];
  /** Only `open` and `orphaned` reviews; archived and draft excluded. */
  reviews: HomeReview[];
  /** `draft` reviews — started but not yet claimed. */
  drafts: HomeReview[];
  /** Repo id → open pulls (all, including already-reviewed ones; screens filter). */
  pullsByRepo: ReadonlyMap<string, Pull[]>;
  /** Repo id → whether `gh` was available for that repo's pull list. */
  pullsAvailable: ReadonlyMap<string, boolean>;
  me: Me | null;
  /** True while the first load is in flight (no data yet). */
  loading: boolean;
  /** True while a later refresh is in flight. */
  refreshing: boolean;
  /** Last load error message; cleared on success. */
  error: string | null;
  lastLoadedAt: number | null;
}

export interface HomeActions {
  refresh(options?: { force?: boolean }): Promise<void>;
  openPull(repoId: string, pull: Pull): Promise<void>;
  openBranch(repoId: string, branch: Branch | string): Promise<void>;
  archiveReview(id: string): Promise<void>;
  unarchiveReview(id: string): Promise<void>;
  generateReadingOrder(id: string): Promise<void>;
  addRepo(path: string): Promise<Repo>;
}

const AUTO_REFRESH_THROTTLE_MS = 30_000;
/** Coalesces a burst of `reviews.changed` (one action often sends several) into one refetch. */
const LIVE_REFRESH_DEBOUNCE_MS = 250;

function defaultSummary(reviewId: string): ReviewSummary {
  return {
    reviewId,
    openThreads: 0,
    resolvedThreads: 0,
    viewedFiles: 0,
    readingOrderVersion: null,
    agentRunning: false,
    lastActivityAt: null,
    title: null,
    authorName: null,
    filesTotal: null,
    additions: null,
    deletions: null,
    headSha: null,
    headCommittedAt: null,
    ci: null,
    draft: false,
    unreadAgentReplies: 0,
  };
}

function bucketOf(summary: ReviewSummary): Bucket {
  const done =
    summary.filesTotal !== null &&
    summary.filesTotal > 0 &&
    summary.viewedFiles >= summary.filesTotal &&
    summary.openThreads === 0;
  return done ? 'done' : 'attention';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

let snapshot: HomeSnapshot = {
  repos: [],
  reviews: [],
  drafts: [],
  pullsByRepo: new Map(),
  pullsAvailable: new Map(),
  me: null,
  // True from the start: the first `useHomeData()` mount kicks off a load
  // almost immediately, and there is no data to show in the meantime either
  // way — screens key their initial skeleton off this.
  loading: true,
  refreshing: false,
  error: null,
  lastLoadedAt: null,
};

const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let windowListenersRegistered = false;
let liveUpdatesRegistered = false;

function setSnapshot(next: HomeSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function patch(partial: Partial<HomeSnapshot>): void {
  setSnapshot({ ...snapshot, ...partial });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): HomeSnapshot {
  return snapshot;
}

async function doLoad(force: boolean): Promise<void> {
  const isFirstLoad = snapshot.lastLoadedAt === null;
  patch(isFirstLoad ? { loading: true, error: null } : { refreshing: true, error: null });

  try {
    const refreshQuery = force ? ({ refresh: 'true' } as const) : {};
    // Only the pulls wait on the repo list; everything else goes out at once.
    const reposPromise = callApi('listRepos');
    const pullsPromise = reposPromise.then((res) =>
      Promise.all(
        res.repos.map(async (repo) => {
          try {
            const pulls = await callApi('listPulls', { params: [repo.id], query: refreshQuery });
            return { repoId: repo.id, available: pulls.available, pulls: pulls.pulls };
          } catch {
            return { repoId: repo.id, available: false, pulls: [] as Pull[] };
          }
        }),
      ),
    );
    const [reposRes, meRes, reviewsRes, pullsResults] = await Promise.all([
      reposPromise,
      callApi('me'),
      callApi('listReviews', { query: refreshQuery }),
      pullsPromise,
    ]);
    const repos = reposRes.repos;

    const repoById = new Map(repos.map((r) => [r.id, r] as const));
    const summaryByReviewId = new Map(reviewsRes.summaries.map((s) => [s.reviewId, s] as const));
    const reviews: HomeReview[] = [];
    const drafts: HomeReview[] = [];
    for (const review of reviewsRes.reviews) {
      if (review.status === 'archived') continue;
      const repo = repoById.get(review.repoId);
      if (repo === undefined) continue;
      const summary = summaryByReviewId.get(review.id) ?? defaultSummary(review.id);
      const hr: HomeReview = { review, summary, repo, bucket: bucketOf(summary) };
      if (review.status === 'draft') drafts.push(hr);
      else reviews.push(hr);
    }

    const pullsByRepo = new Map<string, Pull[]>();
    const pullsAvailable = new Map<string, boolean>();
    for (const r of pullsResults) {
      pullsByRepo.set(r.repoId, r.pulls);
      pullsAvailable.set(r.repoId, r.available);
    }

    setSnapshot({
      repos,
      reviews,
      drafts,
      pullsByRepo,
      pullsAvailable,
      me: meRes,
      loading: false,
      refreshing: false,
      error: null,
      lastLoadedAt: Date.now(),
    });
  } catch (err) {
    patch({ loading: false, refreshing: false, error: errorMessage(err, 'Failed to load') });
  }
}

/**
 * A refresh asked for while a load is in flight runs once more after it
 * (forced if any asker forced), rather than joining it: the in-flight load
 * may have read the server before the change that prompted the ask — e.g. a
 * `reviews.changed` from a background git/`gh` refresh landing while a slow
 * `listPulls` is still pending — and that change would otherwise be lost.
 */
let rerun: { force: boolean } | null = null;

async function refresh(options?: { force?: boolean }): Promise<void> {
  const force = options?.force ?? false;
  if (inFlight !== null) {
    rerun = { force: force || (rerun?.force ?? false) };
    await inFlight;
    return;
  }
  const promise = (async () => {
    let next: { force: boolean } | null = { force };
    while (next !== null) {
      rerun = null;
      await doLoad(next.force);
      next = rerun;
    }
  })();
  inFlight = promise;
  try {
    await promise;
  } finally {
    inFlight = null;
  }
}

async function openPull(repoId: string, pull: Pull): Promise<void> {
  if (pull.reviewId !== null) {
    goReview(pull.reviewId);
    return;
  }
  try {
    const detail = await callApi('createReview', {
      body: { repoId, branch: pull.headRefName, base: pull.baseRefName, prNumber: pull.number, status: 'draft' },
    });
    goReview(detail.review.id);
    void refresh();
  } catch (err) {
    patch({ error: errorMessage(err, 'Failed to open pull request') });
    void refresh();
    throw err;
  }
}

async function openBranch(repoId: string, branch: Branch | string): Promise<void> {
  const name = typeof branch === 'string' ? branch : branch.name;
  const reviewId = typeof branch === 'string' ? null : branch.reviewId;
  if (reviewId !== null) {
    goReview(reviewId);
    return;
  }
  try {
    const detail = await callApi('createReview', { body: { repoId, branch: name, status: 'draft' } });
    goReview(detail.review.id);
    void refresh();
  } catch (err) {
    patch({ error: errorMessage(err, 'Failed to open branch') });
    void refresh();
    throw err;
  }
}

async function archiveReview(id: string): Promise<void> {
  // Optimistic: drop it from the snapshot immediately, then let `refresh`
  // reconcile with the server either way (including undoing this if the
  // request actually failed).
  patch({
    reviews: snapshot.reviews.filter((r) => r.review.id !== id),
    drafts: snapshot.drafts.filter((r) => r.review.id !== id),
  });
  try {
    await callApi('setReviewStatus', { params: [id], body: { status: 'archived' } });
  } catch (err) {
    patch({ error: errorMessage(err, 'Failed to archive review') });
  }
  await refresh();
}

async function unarchiveReview(id: string): Promise<void> {
  try {
    await callApi('setReviewStatus', { params: [id], body: { status: 'open' } });
  } catch (err) {
    patch({ error: errorMessage(err, 'Failed to unarchive review') });
  }
  await refresh();
}

async function generateReadingOrder(id: string): Promise<void> {
  patch({
    reviews: snapshot.reviews.map((r) =>
      r.review.id === id ? { ...r, summary: { ...r.summary, agentRunning: true } } : r,
    ),
  });
  try {
    await callApi('generateReadingOrder', { params: [id], body: {} });
  } catch (err) {
    patch({ error: errorMessage(err, 'Failed to generate reading order') });
  }
  await refresh();
}

async function addRepo(path: string): Promise<Repo> {
  try {
    const res = await callApi('addRepo', { body: { path } });
    await refresh();
    return res.repo;
  } catch (err) {
    patch({ error: errorMessage(err, 'Failed to add repository') });
    throw err;
  }
}

function shouldSkipAutoRefresh(): boolean {
  return snapshot.lastLoadedAt !== null && Date.now() - snapshot.lastLoadedAt < AUTO_REFRESH_THROTTLE_MS;
}

function onWindowRefocus(): void {
  if (shouldSkipAutoRefresh()) return;
  void refresh();
}

let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let liveMounts = 0;

/**
 * Live updates while a Homebase/Explore screen is mounted: the server sends
 * `reviews.changed` whenever something a card shows changes (a thread, a
 * run starting or ending, a review created or archived, ...), and the store
 * refetches. Subscribed only while mounted, so an open review window
 * doesn't trigger background Homebase refetches on every comment; coming
 * back refetches once to catch up. Returns the unmount half.
 */
function mountLiveUpdates(): () => void {
  if (!liveUpdatesRegistered) {
    liveUpdatesRegistered = true;
    eventsClient.onEvent((event) => {
      if (event.type !== 'reviews.changed' || liveMounts === 0) return;
      if (liveRefreshTimer !== null) clearTimeout(liveRefreshTimer);
      liveRefreshTimer = setTimeout(() => {
        liveRefreshTimer = null;
        void refresh();
      }, LIVE_REFRESH_DEBOUNCE_MS);
    });
  }
  liveMounts += 1;
  if (liveMounts === 1) {
    eventsClient.connect();
    eventsClient.subscribeHome();
    if (snapshot.lastLoadedAt !== null) void refresh();
  }
  return () => {
    liveMounts -= 1;
    if (liveMounts === 0) eventsClient.unsubscribeHome();
  };
}

/**
 * Registered once, ever, the first time any component mounts `useHomeData`
 * — not per-component and never torn down, since the store outlives any one
 * screen.
 */
function ensureWindowListeners(): void {
  if (windowListenersRegistered) return;
  windowListenersRegistered = true;
  window.addEventListener('focus', onWindowRefocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onWindowRefocus();
  });
}

const actions: HomeActions = {
  refresh,
  openPull,
  openBranch,
  archiveReview,
  unarchiveReview,
  generateReadingOrder,
  addRepo,
};

export function useHomeData(): HomeSnapshot & HomeActions {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    ensureWindowListeners();
    // Lazily kick off the first load on first mount; StrictMode's
    // double-invoke re-enters this with `inFlight` already set, so the
    // second call is a no-op rather than a second fetch.
    if (snapshot.lastLoadedAt === null && inFlight === null) {
      void refresh();
    }
  }, []);

  useEffect(() => mountLiveUpdates(), []);

  return { ...state, ...actions };
}
