/**
 * Bearer token auth (SPEC §10) from `data/token`, required on every `/api`
 * route. A WebSocket upgrade request can't set an `Authorization` header
 * from a browser's native `WebSocket`, so the token is also accepted as a
 * `?token=` query parameter there (SPEC doesn't specify the mechanism, only
 * that every `/api` route is gated).
 */
import type { Context, Next } from 'hono';
import { unauthorized } from './errors.ts';

export function requireBearerToken(token: string) {
  return async (c: Context, next: Next): Promise<void> => {
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const queryToken = c.req.query('token');
    const provided = bearer ?? queryToken;

    if (provided === undefined || provided !== token) {
      throw unauthorized('missing or invalid bearer token');
    }
    await next();
  };
}
