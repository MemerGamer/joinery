import { describe, expect, test } from 'bun:test';
import { apiFetch, setupHttp } from './helpers.ts';

describe('auth: bearer token on /api/*', () => {
  test('rejects a missing token with 401', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos', { auth: 'none' });
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('unauthorized');
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects a wrong bearer token with 401', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos', { auth: 'bad' });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects a malformed Authorization header (no "Bearer " prefix) with 401', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos', {
        auth: 'none',
        headers: { authorization: fixture.token },
      });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects "Bearer" with no token after it with 401', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos', {
        auth: 'none',
        headers: { authorization: 'Bearer' },
      });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('accepts a correct Bearer header', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos', { auth: 'bearer' });
      expect(res.status).toBe(200);
    } finally {
      await fixture.cleanup();
    }
  });

  test('accepts the ?token= query parameter (needed for the WS upgrade, which cannot set headers)', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos', { auth: 'query' });
      expect(res.status).toBe(200);
    } finally {
      await fixture.cleanup();
    }
  });

  test('a wrong ?token= query parameter is rejected with 401 (not usable to bypass auth)', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos?token=totally-wrong', { auth: 'none' });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('an empty ?token= query parameter is rejected with 401', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/repos?token=', { auth: 'none' });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('a bad bearer header is not overridden by a correct query token (header wins, and here it is wrong)', async () => {
    const fixture = await setupHttp();
    try {
      const url = `/api/repos?token=${fixture.token}`;
      const res = await apiFetch(fixture, 'GET', url, { auth: 'bad' });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('non-/api paths are NOT gated by auth', async () => {
    const fixture = await setupHttp();
    try {
      // No web dist in this fixture, so the static fallback page is served
      // (200), but the point is it's not a 401 for lack of a token.
      const res = await apiFetch(fixture, 'GET', '/', { auth: 'none' });
      expect(res.status).not.toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });

  test('the WS upgrade route GET /api/events is gated like any other /api route', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/events', { auth: 'none' });
      expect(res.status).toBe(401);
    } finally {
      await fixture.cleanup();
    }
  });
});
