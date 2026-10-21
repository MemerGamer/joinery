/**
 * `WS /api/events`. A connection `watch`es the topics it shows (`home`,
 * `repo:<id>`, `review:<id>`) and gets only their events; Bun's native topic
 * pub/sub does the fan-out (`engine/bus.ts` publishes). The browser never
 * polls: watching `review:<id>` sends the review's current file list and
 * state back at once, and reconnecting is "watch again".
 */
import { createBunWebSocket } from 'hono/bun';
import type { Hono } from 'hono';
import type { ServerWebSocket } from 'bun';
import { clientMessageSchema, type ServerEvent, type Topic } from '@joinery/core';
import type { EngineRegistry } from '../engine/index.ts';

export type { BunWebSocketHandler } from 'hono/bun';

const REVIEW_PREFIX = 'review:';

/** Auth is applied by the caller's blanket `/api/*` middleware; this only wires the upgrade. */
export function mountWebSocket(app: Hono, registry: EngineRegistry) {
  const { upgradeWebSocket, websocket } = createBunWebSocket();

  app.get(
    '/api/events',
    upgradeWebSocket(() => {
      // What this connection watches, and for `review:<id>` the release
      // that lets the review's live worker go once nobody watches it.
      const watching = new Map<Topic, (() => void) | null>();

      const send = (ws: { send: (data: string) => void }, event: ServerEvent): void => {
        ws.send(JSON.stringify(event));
      };

      return {
        async onMessage(evt, ws) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
          } catch {
            return;
          }
          const result = clientMessageSchema.safeParse(parsed);
          if (!result.success) return;
          const message = result.data;
          const raw = ws.raw as ServerWebSocket<unknown> | undefined;

          switch (message.type) {
            case 'watch': {
              const { topic } = message;
              if (watching.has(topic)) break;
              watching.set(topic, null);
              if (!topic.startsWith(REVIEW_PREFIX)) {
                raw?.subscribe(topic);
                break;
              }
              const reviewId = topic.slice(REVIEW_PREFIX.length);
              const watched = await registry.watch(reviewId);
              if (watched === null) break; // review doesn't exist; nothing will be published
              // Unwatched (or closed) while the worker was starting.
              if (!watching.has(topic)) {
                watched.release();
                break;
              }
              watching.set(topic, watched.release);
              // Joined only now: the worker's first tick (above) is already
              // in the snapshot sent next, so it isn't delivered twice.
              raw?.subscribe(topic);
              send(ws, { type: 'files.changed', reviewId, list: watched.engine.getFileList() });
              send(ws, { type: 'root.rebound', reviewId, state: await watched.engine.getState() });
              break;
            }
            case 'unwatch': {
              const release = watching.get(message.topic);
              if (release === undefined) break;
              release?.();
              watching.delete(message.topic);
              raw?.unsubscribe(message.topic);
              break;
            }
            case 'focus': {
              await registry.focus(message.reviewId);
              break;
            }
            case 'blur':
            case 'ping':
              break;
          }
        },
        onClose() {
          // Bun drops the socket's topic subscriptions itself.
          for (const release of watching.values()) release?.();
          watching.clear();
        },
      };
    }),
  );

  return websocket;
}
