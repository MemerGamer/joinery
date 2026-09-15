/**
 * `WS /api/events` (SPEC §5 Transport, §10). Accepts the `clientMessage`
 * union, pushes the `ServerEvent` union. The browser never polls: on
 * `subscribe` the server immediately sends the current file list, and
 * reconnecting is "send me the list" again — no handshake, no version
 * negotiation.
 */
import { createBunWebSocket } from 'hono/bun';
import type { Hono } from 'hono';
import { clientMessageSchema, type Revision, type ServerEvent } from '@review/core';
import type { EngineRegistry } from '../engine/index.ts';

export type { BunWebSocketHandler } from 'hono/bun';

/** Auth is applied by the caller's blanket `/api/*` middleware; this only wires the upgrade. */
export function mountWebSocket(app: Hono, registry: EngineRegistry) {
  const { upgradeWebSocket, websocket } = createBunWebSocket();

  app.get(
    '/api/events',
    upgradeWebSocket(() => {
      // One connection may subscribe to several reviews; each has its own
      // unsubscribe function and last-known-focus state.
      const unsubscribers = new Map<string, () => void>();
      // Which revision each subscribed review is filtered to on this
      // connection — lets two tabs on the same review each watch a different
      // revision without a `files.changed` for one leaking into the other.
      // `undefined` means "no filter, forward everything" (a client that
      // never sent a revision).
      const subscribedRevision = new Map<string, Revision | undefined>();
      let focusedReviewId: string | null = null;

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

          switch (message.type) {
            case 'subscribe': {
              // Update (or set) this connection's revision filter for the
              // review even if already subscribed — this is also how a tab
              // switches what it's watching without a fresh subscription.
              subscribedRevision.set(message.reviewId, message.revision);
              if (!unsubscribers.has(message.reviewId)) {
                const unsubscribe = await registry.subscribe(message.reviewId, (event) => {
                  if (event.type === 'files.changed' && event.reviewId === message.reviewId) {
                    const wanted = subscribedRevision.get(message.reviewId);
                    if (wanted !== undefined && event.list.revision !== wanted) return;
                  }
                  send(ws, event);
                });
                if (unsubscribe === null) return; // review doesn't exist; silently ignore
                unsubscribers.set(message.reviewId, unsubscribe);
              }
              const engine = await registry.get(message.reviewId);
              if (engine !== null) {
                send(ws, { type: 'files.changed', reviewId: message.reviewId, list: engine.getFileList(message.revision) });
                send(ws, { type: 'root.rebound', reviewId: message.reviewId, state: await engine.getState() });
              }
              break;
            }
            case 'unsubscribe': {
              unsubscribers.get(message.reviewId)?.();
              unsubscribers.delete(message.reviewId);
              subscribedRevision.delete(message.reviewId);
              break;
            }
            case 'focus': {
              focusedReviewId = message.reviewId;
              await registry.focus(message.reviewId);
              break;
            }
            case 'blur': {
              if (focusedReviewId === message.reviewId) focusedReviewId = null;
              await registry.blur(message.reviewId);
              break;
            }
            case 'ping':
              break;
          }
        },
        onClose() {
          for (const unsubscribe of unsubscribers.values()) unsubscribe();
          unsubscribers.clear();
          if (focusedReviewId !== null) void registry.blur(focusedReviewId);
        },
      };
    }),
  );

  return websocket;
}
