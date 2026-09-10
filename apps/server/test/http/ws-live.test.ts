/**
 * Real `WS /api/events` dispatch coverage (SPEC §9). Unlike the rest of the
 * http suite, these tests drive an actual `Bun.serve` on an ephemeral port
 * (`port: 0`, read back off the server — see `startLiveServer` in
 * `helpers.ts`) with a real `WebSocket` client, because hono's Bun adapter
 * only wires `onMessage`/`onClose` for a genuine upgrade (see `ws.test.ts`'s
 * module comment for why plain `app.fetch()` can't reach this code).
 *
 * Every server is closed in a `finally`, including on failure. Every "wait
 * for a message" is wrapped in a short, deterministic timeout so a bug here
 * fails the test instead of hanging the suite.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerEvent } from '@review/core';
import { createReview } from '../../src/db/index.ts';
import { runGit, setupHttpWithReview, startLiveServer, type HttpFixture } from './helpers.ts';

/** Small queue-backed client: messages that arrive before `next()` is called are buffered. */
class WsClient {
  readonly ws: WebSocket;
  readonly #queue: unknown[] = [];
  readonly #waiters: Array<(msg: unknown) => void> = [];
  readonly #closeWaiters: Array<(evt: CloseEvent) => void> = [];
  closeEvent: CloseEvent | null = null;
  lastError: Event | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (evt: MessageEvent) => {
      const raw = typeof evt.data === 'string' ? evt.data : '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = raw;
      }
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(parsed);
      else this.#queue.push(parsed);
    });
    this.ws.addEventListener('error', (evt: Event) => {
      this.lastError = evt;
    });
    this.ws.addEventListener('close', (evt: CloseEvent) => {
      this.closeEvent = evt;
      for (const waiter of this.#closeWaiters.splice(0)) waiter(evt);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string | ArrayBufferLike | Uint8Array): void {
    this.ws.send(data as never);
  }

  async waitForOpen(timeoutMs = 2000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for websocket open after ${timeoutMs}ms`)), timeoutMs);
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('websocket errored before opening'));
        },
        { once: true },
      );
      this.ws.addEventListener(
        'close',
        (evt) => {
          clearTimeout(timer);
          reject(new Error(`websocket closed before opening (code=${String((evt as CloseEvent).code)})`));
        },
        { once: true },
      );
    });
  }

  async waitForClose(timeoutMs = 2000): Promise<CloseEvent> {
    if (this.closeEvent !== null) return this.closeEvent;
    return await new Promise<CloseEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for websocket close after ${timeoutMs}ms`)), timeoutMs);
      this.#closeWaiters.push((evt) => {
        clearTimeout(timer);
        resolve(evt);
      });
    });
  }

  /** Resolves with the next message, buffered or future. Rejects if none arrives in time. */
  async next(timeoutMs = 2000): Promise<unknown> {
    if (this.#queue.length > 0) return this.#queue.shift();
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for a websocket message after ${timeoutMs}ms`)), timeoutMs);
      this.#waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  /**
   * Asserts nothing arrives within `ms` — used to prove silent-ignore /
   * unsubscribe behavior. Must not leave a dangling waiter behind: on the
   * (expected) timeout path the registered waiter is removed from
   * `#waiters`, otherwise it would steal the *next* real message a later
   * `next()` call is waiting for.
   */
  async expectSilence(ms = 300): Promise<void> {
    if (this.#queue.length > 0) throw new Error(`expected silence but a message was already queued: ${JSON.stringify(this.#queue[0])}`);
    const SILENT = Symbol('silent');
    let waiter: ((msg: unknown) => void) | undefined;
    const result = await new Promise<unknown | typeof SILENT>((resolve) => {
      const timer = setTimeout(() => resolve(SILENT), ms);
      waiter = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.#waiters.push(waiter);
    });
    const idx = waiter === undefined ? -1 : this.#waiters.indexOf(waiter);
    if (idx >= 0) this.#waiters.splice(idx, 1);
    if (result !== SILENT) {
      throw new Error(`expected silence for ${String(ms)}ms but received a message: ${JSON.stringify(result)}`);
    }
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(url: string): Promise<WsClient> {
  const client = new WsClient(url);
  await client.waitForOpen();
  return client;
}

/** Asserts `evt` is a `ServerEvent` of the given `type` and narrows to it, so callers can read its other fields. */
function expectEventType<T extends ServerEvent['type']>(evt: ServerEvent, type: T): Extract<ServerEvent, { type: T }> {
  expect(evt.type).toBe(type);
  if (evt.type !== type) throw new Error(`expected event type ${type}, got ${evt.type}`);
  return evt as Extract<ServerEvent, { type: T }>;
}

/**
 * A second review on the same repo (distinct from `fixture.review`), on its
 * own never-checked-out branch — a `working` (attached) review needs a real
 * checkout to attach to, and there's only one working directory in this
 * fixture, so `head` off an unattached branch ref is what keeps the two
 * reviews from fighting over the filesystem. A *pinned-sha* review was
 * tried first, but its every commit is reachable from `feature` (already
 * `fixture.review`'s branch), so SPEC §4 auto-adoption (`#maybeAdoptBranch`)
 * raced to claim the same `(repo, branch)` row and hit the unique index.
 */
async function createSecondReview(fixture: HttpFixture & { repo: { id: string } }) {
  runGit(fixture.repoDir, ['branch', 'second-branch']);
  return await createReview(fixture.db, {
    repoId: fixture.repo.id,
    branch: 'second-branch',
    pinnedSha: null,
    baseRef: 'main',
  });
}

describe('WS /api/events: subscribe', () => {
  test('sends files.changed then root.rebound for an existing review, and forwards later engine events', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'subscribe', reviewId: fixture.review.id });

      const first = expectEventType((await client.next()) as ServerEvent, 'files.changed');
      expect(first.reviewId).toBe(fixture.review.id);

      const second = expectEventType((await client.next()) as ServerEvent, 'root.rebound');
      expect(second.reviewId).toBe(fixture.review.id);

      // A later, discretely-dispatched engine event (e.g. a thread created over HTTP) is forwarded too.
      fixture.registry.dispatch(fixture.review.id, { type: 'reading_order.updated', reviewId: fixture.review.id });
      const third = (await client.next()) as ServerEvent;
      expect(third).toEqual({ type: 'reading_order.updated', reviewId: fixture.review.id });
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });

  test('subscribing twice to the same review is a no-op the second time (no duplicate initial push)', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      await client.next(); // files.changed
      await client.next(); // root.rebound

      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      // No second files.changed/root.rebound pair should arrive.
      await client.expectSilence();
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });

  test('subscribing to an unknown review id is silently ignored, and the connection keeps working', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'subscribe', reviewId: 'no-such-review' });
      await client.expectSilence();

      // The connection is still alive and can subscribe to a real review.
      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      const msg = (await client.next()) as ServerEvent;
      expect(msg.type).toBe('files.changed');
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });
});

describe('WS /api/events: malformed messages are dropped, never crash the connection or the server', () => {
  test('non-JSON text is ignored', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.sendRaw('this is not json');
      await client.expectSilence();

      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      const msg = (await client.next()) as ServerEvent;
      expect(msg.type).toBe('files.changed');
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });

  test('JSON that fails clientMessageSchema is ignored', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'bogus-type' });
      client.send({ type: 'subscribe' }); // missing reviewId
      await client.expectSilence();

      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      const msg = (await client.next()) as ServerEvent;
      expect(msg.type).toBe('files.changed');
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });

  test('a binary frame is ignored without closing the connection', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.sendRaw(new Uint8Array([1, 2, 3, 4]));
      await client.expectSilence();
      expect(client.ws.readyState).toBe(WebSocket.OPEN);

      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      const msg = (await client.next()) as ServerEvent;
      expect(msg.type).toBe('files.changed');
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });

  test('the server itself survives a burst of malformed frames from one client and keeps serving another', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const bad = await connect(server.wsUrl());
    const good = await connect(server.wsUrl());
    try {
      bad.sendRaw('not json');
      bad.send({ type: 'nope' });
      bad.sendRaw(new Uint8Array([9, 9, 9]));

      good.send({ type: 'subscribe', reviewId: fixture.review.id });
      const msg = (await good.next()) as ServerEvent;
      expect(msg.type).toBe('files.changed');
    } finally {
      bad.close();
      good.close();
      server.stop();
      await fixture.cleanup();
    }
  });
});

describe('WS /api/events: unsubscribe', () => {
  test('detaches the listener; further events for that review are not forwarded', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      await client.next(); // files.changed
      await client.next(); // root.rebound

      client.send({ type: 'unsubscribe', reviewId: fixture.review.id });

      // 'unsubscribe' travels over the real socket asynchronously; wait for
      // it to actually land (subscriberCount back to 0) before dispatching,
      // otherwise the probe event can race ahead of the server processing it.
      const engine = await fixture.registry.get(fixture.review.id);
      const deadline = Date.now() + 2000;
      while (engine?.subscriberCount !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(engine?.subscriberCount).toBe(0);

      fixture.registry.dispatch(fixture.review.id, { type: 'reading_order.updated', reviewId: fixture.review.id });
      await client.expectSilence();
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });
});

describe('WS /api/events: focus / blur / ping dispatch to the registry', () => {
  test('focus and blur are forwarded to EngineRegistry with the message reviewId, and ping is a no-op', async () => {
    const fixture = await setupHttpWithReview();
    const focusCalls: string[] = [];
    const blurCalls: string[] = [];
    const originalFocus = fixture.registry.focus.bind(fixture.registry);
    const originalBlur = fixture.registry.blur.bind(fixture.registry);
    fixture.registry.focus = async (reviewId: string) => {
      focusCalls.push(reviewId);
      await originalFocus(reviewId);
    };
    fixture.registry.blur = async (reviewId: string) => {
      blurCalls.push(reviewId);
      await originalBlur(reviewId);
    };

    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      await client.next();
      await client.next();

      client.send({ type: 'focus', reviewId: fixture.review.id });
      client.send({ type: 'ping' });
      client.send({ type: 'blur', reviewId: fixture.review.id });

      // Dispatch is async (awaits registry.focus/blur inside onMessage); poll briefly rather than sleep long.
      const deadline = Date.now() + 2000;
      while ((focusCalls.length === 0 || blurCalls.length === 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(focusCalls).toEqual([fixture.review.id]);
      expect(blurCalls).toEqual([fixture.review.id]);

      // ping produced no message and did not disturb the connection.
      await client.expectSilence();
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });

  test('blur is still forwarded even when the review was never focused (matches onMessage: unconditional registry.blur call)', async () => {
    const fixture = await setupHttpWithReview();
    const blurCalls: string[] = [];
    const originalBlur = fixture.registry.blur.bind(fixture.registry);
    fixture.registry.blur = async (reviewId: string) => {
      blurCalls.push(reviewId);
      await originalBlur(reviewId);
    };

    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      await client.next();
      await client.next();

      client.send({ type: 'blur', reviewId: fixture.review.id });

      const deadline = Date.now() + 2000;
      while (blurCalls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blurCalls).toEqual([fixture.review.id]);
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });
});

describe('WS /api/events: onClose cleanup', () => {
  test('closing unsubscribes the connection and blurs its focused review, with no leaked subscriber state', async () => {
    const fixture = await setupHttpWithReview();
    const blurCalls: string[] = [];
    const originalBlur = fixture.registry.blur.bind(fixture.registry);
    fixture.registry.blur = async (reviewId: string) => {
      blurCalls.push(reviewId);
      await originalBlur(reviewId);
    };

    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl());
    try {
      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      await client.next();
      await client.next();
      client.send({ type: 'focus', reviewId: fixture.review.id });

      const engine = await fixture.registry.get(fixture.review.id);
      expect(engine).not.toBeNull();
      // Poll for focus to actually land before we assert on subscriberCount below.
      const focusDeadline = Date.now() + 2000;
      while (engine?.subscriberCount !== 1 && Date.now() < focusDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(engine?.subscriberCount).toBe(1);

      client.close();
      await client.waitForClose();

      // onClose runs synchronously with the server-side close, but poll briefly to be safe against scheduling.
      const deadline = Date.now() + 2000;
      while (engine?.subscriberCount !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(engine?.subscriberCount).toBe(0);
      expect(blurCalls).toEqual([fixture.review.id]); // onClose auto-blurs the focused review
    } finally {
      server.stop();
      await fixture.cleanup();
    }
  });

  test('repeated connect/subscribe/disconnect cycles do not leak subscriber entries', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    try {
      const engine = await fixture.registry.get(fixture.review.id);
      expect(engine).not.toBeNull();

      for (let i = 0; i < 5; i++) {
        const client = await connect(server.wsUrl());
        client.send({ type: 'subscribe', reviewId: fixture.review.id });
        await client.next();
        await client.next();
        client.close();
        await client.waitForClose();

        const deadline = Date.now() + 2000;
        while (engine?.subscriberCount !== 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(engine?.subscriberCount).toBe(0);
      }
    } finally {
      server.stop();
      await fixture.cleanup();
    }
  });
});

describe('WS /api/events: auth on the real upgrade', () => {
  test('a connection without ?token= never opens and is closed by the server', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    try {
      const client = new WsClient(server.wsUrl({ token: null }));
      await expect(client.waitForOpen(2000)).rejects.toThrow();
    } finally {
      server.stop();
      await fixture.cleanup();
    }
  });

  test('a connection with a wrong ?token= never opens', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    try {
      const client = new WsClient(server.wsUrl({ token: 'wrong-token' }));
      await expect(client.waitForOpen(2000)).rejects.toThrow();
    } finally {
      server.stop();
      await fixture.cleanup();
    }
  });

  test('a connection with the correct ?token= opens and can subscribe', async () => {
    const fixture = await setupHttpWithReview();
    const server = startLiveServer(fixture);
    const client = await connect(server.wsUrl({ token: fixture.token }));
    try {
      client.send({ type: 'subscribe', reviewId: fixture.review.id });
      const msg = (await client.next()) as ServerEvent;
      expect(msg.type).toBe('files.changed');
    } finally {
      client.close();
      server.stop();
      await fixture.cleanup();
    }
  });
});

describe('WS /api/events: fan-out isolation', () => {
  test('two clients subscribed to different reviews each receive only their own review events', async () => {
    const fixture = await setupHttpWithReview();
    const review2 = await createSecondReview(fixture);
    const server = startLiveServer(fixture);
    const clientA = await connect(server.wsUrl());
    const clientB = await connect(server.wsUrl());
    try {
      clientA.send({ type: 'subscribe', reviewId: fixture.review.id });
      await clientA.next(); // files.changed
      await clientA.next(); // root.rebound

      clientB.send({ type: 'subscribe', reviewId: review2.id });
      await clientB.next(); // files.changed
      await clientB.next(); // root.rebound

      fixture.registry.dispatch(fixture.review.id, { type: 'reading_order.updated', reviewId: fixture.review.id });
      const forA = (await clientA.next()) as ServerEvent;
      expect(forA).toEqual({ type: 'reading_order.updated', reviewId: fixture.review.id });
      await clientB.expectSilence();

      fixture.registry.dispatch(review2.id, { type: 'reading_order.updated', reviewId: review2.id });
      const forB = (await clientB.next()) as ServerEvent;
      expect(forB).toEqual({ type: 'reading_order.updated', reviewId: review2.id });
      await clientA.expectSilence();
    } finally {
      clientA.close();
      clientB.close();
      server.stop();
      await fixture.cleanup();
    }
  });
});
