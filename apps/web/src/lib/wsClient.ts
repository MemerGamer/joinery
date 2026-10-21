/**
 * WS client over `/api/events`.
 *
 * Screens `watch` the topics they show (`home`, `repo:<id>`, `review:<id>`)
 * and get only those topics' events. Watches are reference-counted, so two
 * components showing the same topic share one subscription. `topic.changed`
 * carries no data — `liveQueries.ts` turns it into a TanStack Query
 * invalidation — and an older one than the last seen for its topic is
 * dropped. The review window's live events (`files.changed`, ...) still carry
 * their payload. Reconnect is "watch again": on open every watched topic is
 * re-sent, and `onReconnect` listeners re-read whatever they show, since
 * events may have been missed while the socket was down.
 */
import { getAuthToken } from './apiClient.ts';
import { clientMessageSchema, serverEventSchema, type ClientMessage, type ServerEvent, type Topic } from '@joinery/core';

type Listener = (event: ServerEvent) => void;

export class EventsClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly reconnectListeners = new Set<() => void>();
  /** topic -> how many watchers want it. */
  private readonly watched = new Map<Topic, number>();
  /** topic -> the newest `topic.changed` version handled, to drop an older one. */
  private readonly lastVersion = new Map<string, number>();
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private everOpened = false;

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
      // A restarted server counts versions from scratch.
      this.lastVersion.clear();
      for (const topic of this.watched.keys()) this.sendRaw({ type: 'watch', topic });
      if (this.everOpened) for (const listener of this.reconnectListeners) listener();
      this.everOpened = true;
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
      const event = result.data;
      if (event.type === 'topic.changed') {
        if (event.version <= (this.lastVersion.get(event.topic) ?? 0)) return;
        this.lastVersion.set(event.topic, event.version);
      }
      for (const listener of this.listeners) listener(event);
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
   * Receive `topic`'s events until the returned function is called. Watching
   * `review:<id>` also gets that review's current file list and state back.
   */
  watch(topic: Topic): () => void {
    this.connect();
    const count = this.watched.get(topic) ?? 0;
    this.watched.set(topic, count + 1);
    if (count === 0) this.sendRaw({ type: 'watch', topic });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.watched.get(topic) ?? 1) - 1;
      if (left > 0) {
        this.watched.set(topic, left);
        return;
      }
      this.watched.delete(topic);
      this.lastVersion.delete(topic);
      this.sendRaw({ type: 'unwatch', topic });
    };
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

  /** Called after the socket reopened (not on the first open). */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

export const eventsClient = new EventsClient();
