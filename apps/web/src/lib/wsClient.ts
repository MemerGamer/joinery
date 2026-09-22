/**
 * WS client over `/api/events` (SPEC §5 *Transport*, §10).
 *
 * The server sends the *current* file list on `files.changed`; there is no
 * delta protocol on the wire — the client set-diffs it against the list it
 * already holds (see `useReviewFileList` in `state/ReviewContext.tsx`).
 * Reconnect is "send me the list again": on open we resend `subscribe` for
 * every review currently subscribed to.
 */
import { getAuthToken } from './apiClient.ts';
import {
  clientMessageSchema,
  serverEventSchema,
  type ClientMessage,
  type Revision,
  type ServerEvent,
} from '@review/core';

type Listener = (event: ServerEvent) => void;

export class EventsClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  /** reviewId -> the revision this connection last asked to watch. */
  private readonly subscribed = new Map<string, Revision | undefined>();
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  /** Whether this connection wants `reviews.changed` (Homebase). */
  private homeSubscribed = false;

  /** Idempotent: a no-op while a connection is already open or opening. */
  connect(): void {
    this.closedByUser = false;
    if (this.ws !== null && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.open();
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // A browser's native WebSocket cannot set an Authorization header on the
    // upgrade, so the token goes in the query string — which the server's
    // auth middleware accepts for exactly this route.
    const token = getAuthToken();
    const auth = token === null ? '' : `?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(`${proto}//${location.host}/api/events${auth}`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = 500;
      for (const [reviewId, revision] of this.subscribed) {
        this.sendRaw({ type: 'subscribe', reviewId, ...(revision === undefined ? {} : { revision }) });
      }
      if (this.homeSubscribed) this.sendRaw({ type: 'subscribeHome' });
    });

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      const result = serverEventSchema.safeParse(parsed);
      if (!result.success) return;
      for (const listener of this.listeners) listener(result.data);
    });

    ws.addEventListener('close', () => {
      if (this.closedByUser) return;
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  private sendRaw(message: ClientMessage): void {
    const parsed = clientMessageSchema.parse(message);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(parsed));
  }

  /**
   * Subscribe, or — if already subscribed — update the revision this
   * connection watches for `reviewId`. Safe to call again on every revision
   * switch: the server treats a repeat `subscribe` as an upsert.
   */
  subscribe(reviewId: string, revision?: Revision): void {
    this.subscribed.set(reviewId, revision);
    this.sendRaw({ type: 'subscribe', reviewId, ...(revision === undefined ? {} : { revision }) });
  }

  unsubscribe(reviewId: string): void {
    this.subscribed.delete(reviewId);
    this.sendRaw({ type: 'unsubscribe', reviewId });
  }

  /** Receive `reviews.changed` whenever anything Homebase shows changes. */
  subscribeHome(): void {
    this.homeSubscribed = true;
    this.sendRaw({ type: 'subscribeHome' });
  }

  unsubscribeHome(): void {
    this.homeSubscribed = false;
    this.sendRaw({ type: 'unsubscribeHome' });
  }

  focus(reviewId: string): void {
    this.sendRaw({ type: 'focus', reviewId });
  }

  blur(reviewId: string): void {
    this.sendRaw({ type: 'blur', reviewId });
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

export const eventsClient = new EventsClient();
