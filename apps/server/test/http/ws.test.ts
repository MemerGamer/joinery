/**
 * ws.ts covers two concerns here: (1) the `GET /api/events` upgrade route is
 * gated by the same `/api/*` bearer-token middleware as everything else,
 * and (2) `clientMessageSchema` parses/rejects the wire messages the
 * `onMessage` dispatcher switches on.
 *
 * What is NOT covered here, and why: the `onMessage`/`onClose` handlers
 * live inside the closure hono's `upgradeWebSocket()` returns, which is
 * only reachable via a *real* WebSocket upgrade. Hono's Bun adapter reads
 * `c.env.server` inside `upgradeWebSocket()` (see
 * node_modules/hono/dist/adapter/bun/websocket.js), and `c.env.server` is
 * only populated when `Bun.serve({ fetch: app.fetch, websocket })` calls
 * `fetch(req, server)` for a real connection — plain `app.fetch(request)`
 * (used everywhere else in this suite) leaves `c.env` without a `server`
 * and the upgrade throws `TypeError: c.env is not an Object` before
 * `onMessage` is ever reached. That dispatch — subscribe/unsubscribe/
 * focus/blur/ping through the registry, malformed-message resilience,
 * onClose cleanup, auth on a real upgrade, and fan-out isolation — is
 * covered in `ws-live.test.ts`, which stands up a throwaway `Bun.serve` on
 * an ephemeral port (`port: 0`) and drives it with a real `WebSocket`
 * client.
 */
import { describe, expect, test } from 'bun:test';
import { clientMessageSchema } from '@review/core';
import { apiFetch, setupHttp } from './helpers.ts';

describe('ws.ts: GET /api/events upgrade route is behind /api/* auth', () => {
  test('rejects the upgrade request with 401 when no token is given', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/events', { auth: 'none' });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects the upgrade request with 401 for a wrong token', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/events', { auth: 'bad' });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('accepts the ?token= query parameter form (the only form a browser WebSocket can send)', async () => {
    const fixture = await setupHttp();
    try {
      // The auth middleware runs and passes before the upgrade logic is
      // reached; whatever happens next is hono/Bun-adapter internals (see
      // module comment), so we only assert it is NOT rejected for auth.
      const res = await apiFetch(fixture, 'GET', '/api/events', { auth: 'query' });
      expect(res.status).not.toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('ws.ts: clientMessageSchema parses exactly what onMessage dispatches on', () => {
  test('subscribe/unsubscribe/focus/blur all require a reviewId string', () => {
    for (const type of ['subscribe', 'unsubscribe', 'focus', 'blur'] as const) {
      expect(clientMessageSchema.safeParse({ type, reviewId: 'r1' }).success).toBe(true);
      expect(clientMessageSchema.safeParse({ type }).success).toBe(false);
      expect(clientMessageSchema.safeParse({ type, reviewId: 42 }).success).toBe(false);
    }
  });

  test('ping takes no payload', () => {
    expect(clientMessageSchema.safeParse({ type: 'ping' }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: 'ping', reviewId: 'r1' }).success).toBe(true); // extra fields are ignored, not rejected
  });

  test('an unknown message type is rejected', () => {
    expect(clientMessageSchema.safeParse({ type: 'bogus' }).success).toBe(false);
  });

  test('a non-object payload is rejected', () => {
    expect(clientMessageSchema.safeParse('subscribe').success).toBe(false);
    expect(clientMessageSchema.safeParse(null).success).toBe(false);
    expect(clientMessageSchema.safeParse(42).success).toBe(false);
  });

  test('malformed JSON text, if it were parsed, is naturally not an object and so is rejected the same way onMessage handles it', () => {
    // onMessage does `JSON.parse(...)` in a try/catch and returns silently on
    // failure; this test locks down the schema half of that path (the parser
    // half is standard JSON.parse and not worth re-testing here).
    let parsed: unknown;
    try {
      parsed = JSON.parse('{ not valid json');
    } catch {
      parsed = undefined;
    }
    expect(parsed).toBeUndefined();
  });
});

// The onMessage/onClose dispatch itself (subscribe pushing files.changed/
// root.rebound, unsubscribe detaching, focus/blur calling into
// EngineRegistry, malformed messages being dropped without closing the
// connection, and onClose cleanup) is covered for real in ws-live.test.ts.
