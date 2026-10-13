/**
 * `EngineRegistry` — one `ReviewEngine` actor per review, created lazily and
 * kept alive while anything subscribes to it.
 */
import type { ServerEvent } from '@joinery/core';
import type { Db } from '../db/index.ts';
import { getRepoById, getReview } from '../db/index.ts';
import { ReviewEngine } from './reviewEngine.ts';

export type EventListener = (event: ServerEvent) => void;

/**
 * Idle-eviction constants. Engines are a ceiling on concurrency, not a promise
 * to keep every engine ever touched alive forever. A `ReviewEngine` pins a poll timer, two recursive
 * `fs.watch` handles, and a live `git cat-file --batch` child process. A
 * one-shot HTTP/CLI call (e.g. `joinery files <id>`) goes through the same
 * `requireEngine` path as a live review window and would otherwise leak all
 * three for the life of the server.
 *
 * `SWEEP_INTERVAL_MS` is how often the registry looks for idle engines.
 * `IDLE_GRACE_MS` is how long an unsubscribed engine survives after its last
 * `get()` before it's disposed. The trade-off: shorter grace = less idle
 * memory/FD/process pressure, but a following one-shot call within the
 * window is instant while one past it pays a warm-up (the first tick has to
 * rebuild the file list from scratch). A live review window always holds a
 * WS subscription (`subscriberCount > 0`), so it is exempt from the sweep no
 * matter how long it sits idle on screen — only unsubscribed engines age
 * out. This is what makes it cheap to create reviews freely by browsing
 * branches in the UI: nothing sticks around unless something is actually
 * watching it.
 */
const SWEEP_INTERVAL_MS = 60_000;
const IDLE_GRACE_MS = 120_000;

interface EngineEntry {
  engine: ReviewEngine;
  lastUsedAt: number;
}

export class EngineRegistry {
  readonly #db: Db;
  readonly #engines = new Map<string, EngineEntry>();
  readonly #listeners = new Map<string, Set<EventListener>>();
  /** Homebase connections (`subscribeHome`), told whenever any review's rows change. */
  readonly #homeListeners = new Set<EventListener>();
  readonly #creating = new Map<string, Promise<ReviewEngine | null>>();
  readonly #sweepTimer: ReturnType<typeof setInterval>;

  constructor(db: Db) {
    this.#db = db;
    this.#sweepTimer = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
    // Don't let the sweep alone keep the process alive (e.g. in tests or a
    // CLI-driven server that should exit once its real work is done).
    this.#sweepTimer.unref?.();
  }

  /** Returns the engine for `reviewId`, creating it on first use. Null if the review doesn't exist. */
  async get(reviewId: string): Promise<ReviewEngine | null> {
    const existing = this.#engines.get(reviewId);
    // A cached entry can be disposed out from under a caller that resumed
    // after an `await` right as the idle sweep ran — treat that as a cache
    // miss and rebuild rather than handing back an engine whose `cat-file`
    // process and watchers are already torn down.
    if (existing !== undefined && !existing.engine.disposed) {
      existing.lastUsedAt = Date.now();
      return existing.engine;
    }

    const inFlight = this.#creating.get(reviewId);
    if (inFlight !== undefined) return inFlight;

    const promise = this.#create(reviewId);
    this.#creating.set(reviewId, promise);
    try {
      return await promise;
    } finally {
      this.#creating.delete(reviewId);
    }
  }

  async #create(reviewId: string): Promise<ReviewEngine | null> {
    const review = await getReview(this.#db, reviewId);
    if (review === null) return null;
    const repo = await getRepoById(this.#db, review.repoId);
    if (repo === null) return null;

    const engine = await ReviewEngine.create({
      db: this.#db,
      repo,
      review,
      emit: (event) => this.#dispatch(reviewId, event),
    });
    this.#engines.set(reviewId, { engine, lastUsedAt: Date.now() });
    return engine;
  }

  /**
   * Disposes every engine that's both unsubscribed (`subscriberCount === 0`
   * — no live review window pinning it open) and idle past `IDLE_GRACE_MS`.
   * One timer for the whole registry rather than one per engine: eviction is
   * a periodic housekeeping pass, not a per-entry deadline that needs to
   * fire precisely.
   */
  #sweep(): void {
    const now = Date.now();
    for (const [reviewId, entry] of this.#engines) {
      if (entry.engine.subscriberCount > 0) continue;
      if (now - entry.lastUsedAt < IDLE_GRACE_MS) continue;
      entry.engine.dispose();
      this.#engines.delete(reviewId);
      this.#listeners.delete(reviewId);
    }
  }

  /**
   * Push an event to a review's listeners without going through an engine
   * tick — for discrete, HTTP-triggered row events (a thread created or
   * replied to, a reading order written, a run started/ended) that aren't
   * themselves file-list changes ("locally-initiated actions ... apply
   * optimistically and are reconciled against the authoritative row").
   */
  dispatch(reviewId: string, event: ServerEvent): void {
    this.#dispatch(reviewId, event);
    this.notifyHome(reviewId);
  }

  /** Tell every Homebase connection its summaries are stale (`reviews.changed`). */
  notifyHome(reviewId: string | null): void {
    const event: ServerEvent = { type: 'reviews.changed', reviewId };
    for (const listener of this.#homeListeners) listener(event);
  }

  /** Subscribe to `reviews.changed` (Homebase). Returns an unsubscribe function. */
  subscribeHome(listener: EventListener): () => void {
    this.#homeListeners.add(listener);
    return () => {
      this.#homeListeners.delete(listener);
    };
  }

  #dispatch(reviewId: string, event: ServerEvent): void {
    const listeners = this.#listeners.get(reviewId);
    if (listeners === undefined) return;
    for (const listener of listeners) listener(event);
  }

  /** Subscribe to a review's events (e.g. one WS connection). Returns an unsubscribe function. */
  async subscribe(reviewId: string, listener: EventListener): Promise<(() => void) | null> {
    const engine = await this.get(reviewId);
    if (engine === null) return null;

    let set = this.#listeners.get(reviewId);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(reviewId, set);
    }
    set.add(listener);
    engine.subscribe();

    return () => {
      set.delete(listener);
      engine.unsubscribe();
      if (set.size === 0) this.#listeners.delete(reviewId);
    };
  }

  async focus(reviewId: string): Promise<void> {
    const engine = await this.get(reviewId);
    engine?.focus();
  }

  async blur(reviewId: string): Promise<void> {
    const engine = await this.get(reviewId);
    engine?.blur();
  }

  /** Called after an HTTP mutation (revision switch, viewed check, ...) so the review ticks promptly. */
  async notifyExternalChange(reviewId: string): Promise<void> {
    const engine = await this.get(reviewId);
    engine?.notifyExternalChange();
  }

  disposeAll(): void {
    clearInterval(this.#sweepTimer);
    for (const entry of this.#engines.values()) entry.engine.dispose();
    this.#engines.clear();
    this.#listeners.clear();
    this.#homeListeners.clear();
  }

  dispose(reviewId: string): void {
    const entry = this.#engines.get(reviewId);
    if (entry === undefined) return;
    entry.engine.dispose();
    this.#engines.delete(reviewId);
    this.#listeners.delete(reviewId);
  }
}
