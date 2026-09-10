/**
 * Exercises `validate.ts`'s `parseBody`/`parseQuery` through real routes:
 * malformed JSON, schema-failing bodies, and bad query params should all
 * produce a structured 400, never a 500 or an unhandled throw.
 */
import { describe, expect, test } from 'bun:test';
import { apiFetch, setupHttp, setupHttpWithReview } from './helpers.ts';

type ErrorBody = { error: { code: string; message: string; hint?: string } };

describe('validate.ts: bad request bodies', () => {
  test('malformed JSON body produces a structured 400, not a 500', async () => {
    const fixture = await setupHttp();
    try {
      const res = await fixture.created.app.fetch(
        new Request('http://localhost/api/repos', {
          method: 'POST',
          headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
          body: '{ this is not json',
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
      expect(typeof json.error.message).toBe('string');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a body failing its zod schema produces a structured 400', async () => {
    const fixture = await setupHttp();
    try {
      // addRepoBodySchema requires a non-empty `path` string.
      const res = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: '' } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
      expect(json.error.message).toContain('invalid body');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a body missing a required field produces a structured 400', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'POST', '/api/repos', { body: {} });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('validate.ts: bad query parameters', () => {
  test('an invalid `rev` query value on GET diff produces a structured 400', async () => {
    const fixture = await setupHttpWithReview();
    try {
      const res = await apiFetch(fixture, 'GET', `/api/reviews/${fixture.review.id}/diff?path=README.md&rev=not-a-revision`);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
      expect(json.error.message).toContain('invalid query');
    } finally {
      await fixture.cleanup();
    }
  });

  test('a missing required query param (`path` on GET diff) produces a structured 400', async () => {
    const fixture = await setupHttpWithReview();
    try {
      const res = await apiFetch(fixture, 'GET', `/api/reviews/${fixture.review.id}/diff`);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
    } finally {
      await fixture.cleanup();
    }
  });

  test('an invalid `status` value on GET threads produces a structured 400', async () => {
    const fixture = await setupHttpWithReview();
    try {
      const res = await apiFetch(fixture, 'GET', `/api/reviews/${fixture.review.id}/threads?status=bogus`);
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
    } finally {
      await fixture.cleanup();
    }
  });
});
