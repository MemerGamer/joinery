/**
 * `EngineRegistry` — one `ReviewEngine` actor per review, created lazily and
 * kept alive while anything subscribes to it (SPEC §5, "Concurrency and
 * safety": one engine actor per review).
 */
import type { ServerEvent } from '@review/core';
import type { Db } from '../db/index.ts';
import { getRepoById, getReview } from '../db/index.ts';
import { ReviewEngine } from './reviewEngine.ts';

export type EventListener = (event: ServerEvent) => void;

export class EngineRegistry {
  readonly #db: Db;
  readonly #engines = new Map<string, ReviewEngine>();
  readonly #listeners = new Map<string, Set<EventListener>>();
  readonly #creating = new Map<string, Promise<ReviewEngine | null>>();

  constructor(db: Db) {
    this.#db = db;
  }

  /** Returns the engine for `reviewId`, creating it on first use. Null if the review doesn't exist. */
  async get(reviewId: string): Promise<ReviewEngine | null> {
    const existing = this.#engines.get(reviewId);
    if (existing !== undefined) return existing;

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
    this.#engines.set(reviewId, engine);
    return engine;
  }

  /**
   * Push an event to a review's listeners without going through an engine
   * tick — for discrete, HTTP-triggered row events (a thread created or
   * replied to, a reading order written, a run started/ended) that aren't
   * themselves file-list changes (SPEC §5 Transport: "locally-initiated
   * actions ... apply optimistically and are reconciled against the
   * authoritative row").
   */
  dispatch(reviewId: string, event: ServerEvent): void {
    this.#dispatch(reviewId, event);
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
    for (const engine of this.#engines.values()) engine.dispose();
    this.#engines.clear();
    this.#listeners.clear();
  }

  dispose(reviewId: string): void {
    const engine = this.#engines.get(reviewId);
    if (engine === undefined) return;
    engine.dispose();
    this.#engines.delete(reviewId);
    this.#listeners.delete(reviewId);
  }
}
