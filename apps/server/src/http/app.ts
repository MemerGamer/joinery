/**
 * Assembles the Hono app: bearer-token auth on every `/api` route (SPEC
 * §10), the route table, `WS /api/events`, and the static web app fallback.
 * Returns both the `Hono` app and the Bun `websocket` handler `Bun.serve`
 * needs alongside `fetch: app.fetch`.
 */
import { Hono } from 'hono';
import type { ServerWebSocket } from 'bun';
import type { BunWebSocketData } from 'hono/bun';
import type { Db } from '../db/index.ts';
import type { EngineRegistry } from '../engine/index.ts';
import type { Invoke } from '../agent/tools.ts';
import { requireBearerToken } from './auth.ts';
import { renderError } from './errors.ts';
import { buildRoutes } from './routes.ts';
import { mountStatic } from './static.ts';
import { mountWebSocket } from './ws.ts';

export type CreateAppOptions = {
  readonly db: Db;
  readonly registry: EngineRegistry;
  readonly token: string;
  readonly webDistDir: string;
};

export type CreatedApp = {
  readonly app: Hono;
  /**
   * Drives the app's own routes in-process, the same way an HTTP client
   * would: builds a `Request` against `http://review.local` carrying the
   * server's own bearer token, and calls `app.fetch`. The embedded agent's
   * `review` MCP tools (`agent/tools.ts`) are thin wrappers over this, so
   * they get exactly the HTTP route's validation, events, and side effects.
   */
  readonly invoke: Invoke;
  readonly websocket: {
    open(ws: ServerWebSocket<BunWebSocketData>): void;
    close(ws: ServerWebSocket<BunWebSocketData>, code?: number, reason?: string): void;
    message(ws: ServerWebSocket<BunWebSocketData>, message: string | { buffer: ArrayBufferLike }): void;
  };
};

export function createApp(options: CreateAppOptions): CreatedApp {
  const app = new Hono();
  app.onError(renderError);

  // Bearer token auth on every /api route (SPEC §10). Mounted before the
  // routes and the WS upgrade both live under /api.
  app.use('/api/*', requireBearerToken(options.token));

  const websocket = mountWebSocket(app, options.registry);

  // Any successful write through the API can change what Homebase shows
  // (a review created or archived, a file viewed, a repo added, ...), so
  // tell Homebase connections to refetch. Row events a route dispatches
  // (and a background agent run's end) also notify via
  // `EngineRegistry.dispatch`; the duplicate is harmless, clients debounce.
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.res.status < 400) options.registry.notifyHome(null);
  });

  // Built before the routes are mounted (`buildRoutes` needs it in
  // `RoutesDeps`, to hand to `runs.ts`) but only ever *called* later, once
  // `app.route('/', routes)` below has populated the same `app` instance —
  // so this closure is a late-bound reference to the full route table, not
  // a snapshot of the (currently empty) one.
  const invoke: Invoke = async (method, path, body) => {
    const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return app.fetch(new Request(new URL(path, 'http://review.local').toString(), init));
  };

  const routes = buildRoutes({ db: options.db, registry: options.registry, invoke });
  app.route('/', routes);

  mountStatic(app, options.webDistDir, options.token);

  return { app, websocket, invoke };
}
