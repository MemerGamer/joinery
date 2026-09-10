/**
 * Unit tests for `errors.ts`: each helper maps to the right status/body
 * shape, and `renderError` turns an arbitrary thrown value into a 500
 * without leaking internals (e.g. a stack trace) to the client.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  badRequest,
  conflict,
  gitError,
  internal,
  notFound,
  renderError,
  unauthorized,
  HttpError,
} from '../../src/http/errors.ts';

describe('errors.ts: helper -> status/code mapping', () => {
  test('badRequest -> 400/bad_request', () => {
    const err = badRequest('nope');
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad_request');
    expect(err.toResponse()).toEqual({ error: { code: 'bad_request', message: 'nope' } });
  });

  test('notFound -> 404/not_found', () => {
    const err = notFound('missing');
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
  });

  test('conflict -> 409/conflict', () => {
    const err = conflict('taken');
    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
  });

  test('unauthorized -> 401/unauthorized', () => {
    const err = unauthorized('nope');
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
  });

  test('gitError -> 502/git_error', () => {
    const err = gitError('git blew up');
    expect(err.status).toBe(502);
    expect(err.code).toBe('git_error');
  });

  test('internal -> 500/internal', () => {
    const err = internal('oops');
    expect(err.status).toBe(500);
    expect(err.code).toBe('internal');
  });

  test('an optional hint is included in the response when given, omitted otherwise', () => {
    const withHint = badRequest('nope', 'try again');
    expect(withHint.toResponse()).toEqual({ error: { code: 'bad_request', message: 'nope', hint: 'try again' } });

    const withoutHint = badRequest('nope');
    expect(withoutHint.toResponse()).toEqual({ error: { code: 'bad_request', message: 'nope' } });
    expect('hint' in withoutHint.toResponse().error).toBe(false);
  });
});

describe('errors.ts: renderError via app.onError', () => {
  function appThatThrows(thrown: unknown): Hono {
    const app = new Hono();
    app.onError(renderError);
    app.get('/boom', () => {
      throw thrown;
    });
    return app;
  }

  test('an HttpError is rendered with its own status and body', async () => {
    const app = appThatThrows(conflict('already exists', 'pick another'));
    const res = await app.fetch(new Request('http://localhost/boom'));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string; hint?: string } };
    expect(json).toEqual({ error: { code: 'conflict', message: 'already exists', hint: 'pick another' } });
  });

  test('an unexpected thrown Error becomes a 500 without leaking a stack trace', async () => {
    const app = appThatThrows(new Error('some internal detail: /secret/path'));
    const res = await app.fetch(new Request('http://localhost/boom'));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('internal');
    // The message is passed through (it's not a secret by itself in this
    // codebase's convention), but there must be no `stack` field or newline-y
    // stack-trace text in the JSON body.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain('.ts:');
    expect(raw.includes('stack')).toBe(false);
  });

  test('renderError itself turns a non-Error thrown value into a well-formed 500', async () => {
    // Hono's own dispatch/compose only ever invokes the registered
    // onError handler for values that are `instanceof Error` (see
    // node_modules/hono/dist/{hono-base,compose}.js: a non-Error throw is
    // rethrown past `onError` rather than passed to it) — so a route that
    // `throw`s a bare string never actually reaches `renderError` through
    // `app.onError` in practice. `renderError`'s own `errorMessage` fallback
    // for non-`Error` values is still real defensive code (e.g. reached if
    // that Hono behaviour ever changes, or if called directly), so it's
    // exercised here by invoking `renderError` directly with a Context
    // rather than by throwing through Hono's dispatcher.
    const app = new Hono();
    app.get('/boom', (c) => renderError('a raw string throw', c));
    const res = await app.fetch(new Request('http://localhost/boom'));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('internal');
    expect(json.error.message).toBe('a raw string throw');
  });

  test('a route that throws a non-Error value propagates past app.onError rather than being caught (Hono framework behaviour, not an errors.ts bug)', () => {
    const app = appThatThrows('a raw string throw');
    // Hono's single-route dispatch path runs the handler synchronously, so
    // the rethrow (see the module comment above) surfaces as a synchronous
    // throw out of `app.fetch` itself, not a rejected Promise.
    expect(() => app.fetch(new Request('http://localhost/boom'))).toThrow('a raw string throw');
  });

  test('HttpError is an instance of Error with a recognizable name', () => {
    const err = new HttpError(400, 'bad_request', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HttpError');
  });
});
