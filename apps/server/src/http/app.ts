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

  const routes = buildRoutes({ db: options.db, registry: options.registry });
  app.route('/', routes);

  mountStatic(app, options.webDistDir, options.token);

  return { app, websocket };
}
