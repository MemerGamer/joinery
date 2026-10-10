/** Small helpers to validate a route's query/body against its `api` schema. */
import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from './errors.ts';

export function parseQuery<S extends z.ZodTypeAny>(schema: S, c: Context): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(c.req.url).searchParams) raw[key] = value;
  const result = schema.safeParse(raw);
  if (!result.success) throw badRequest(`invalid query: ${result.error.message}`);
  return result.data as z.output<S>;
}

export async function parseBody<S extends z.ZodTypeAny>(schema: S, c: Context): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw badRequest(`invalid body: ${result.error.message}`);
  return result.data as z.output<S>;
}
