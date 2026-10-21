/**
 * Topic pub/sub over Bun's native WebSocket topics. A connection `watch`es a
 * topic (`ws.subscribe`), and every publish here reaches exactly the
 * connections watching it; Bun does the fan-out.
 *
 *   home          — anything a Homebase card shows
 *   repo:<id>     — the repo's open pulls
 *   review:<id>   — one review's live events and its stored state
 *
 * Publish only after the write it announces has committed: a client that
 * re-reads on `topic.changed` must see the new data, never the old.
 */
import type { Server } from 'bun';
import { repoTopic, reviewTopic, type ServerEvent, type Topic } from '@joinery/core';

export class EventBus {
  #server: Server<unknown> | null = null;
  /** Per-topic `topic.changed` counter, so clients can skip an older event. */
  readonly #versions = new Map<Topic, number>();

  /** Wired once `Bun.serve` exists; before that (and in tests) publishing is a no-op. */
  attach(server: Server<unknown>): void {
    this.#server = server;
  }

  publish(topic: Topic, event: ServerEvent): void {
    this.#server?.publish(topic, JSON.stringify(event));
  }

  /** `topic.changed` for `topic`: whoever shows it re-reads it. */
  changed(topic: Topic): void {
    const version = (this.#versions.get(topic) ?? 0) + 1;
    this.#versions.set(topic, version);
    this.publish(topic, { type: 'topic.changed', topic, version });
  }

  /** A review's stored state or rows changed: its window and Homebase both re-read. */
  reviewChanged(reviewId: string): void {
    this.changed(reviewTopic(reviewId));
    this.changed('home');
  }

  /** A repo's pulls changed: Explore's pull list and Homebase both re-read. */
  repoChanged(repoId: string): void {
    this.changed(repoTopic(repoId));
    this.changed('home');
  }

  /** How many connections watch `topic` right now (the poller speeds up for watched repos). */
  watchers(topic: Topic): number {
    return this.#server?.subscriberCount(topic) ?? 0;
  }
}
