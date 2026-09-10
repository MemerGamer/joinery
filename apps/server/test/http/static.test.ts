/**
 * static.ts: the token placeholder substitution, per-request reads (no
 * restart needed after rotation), the SPA catch-all not swallowing /api, and
 * the fallback page when `dist` does not exist.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mountStatic } from '../../src/http/static.ts';
import { makeTempDir, removeTempDir } from './helpers.ts';

const PLACEHOLDER = '__REVIEW_TOKEN_PLACEHOLDER__';

async function makeWebDist(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><html><head><title>t</title></head><body><script>window.__TOKEN__ = "${PLACEHOLDER}";</script></body></html>`,
  );
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log("hi");');
}

describe('static.ts: with a built web dist', () => {
  test('GET / substitutes the real token and does not leak the placeholder', async () => {
    const dir = await makeTempDir('review-ui-static-dist-');
    try {
      await makeWebDist(dir);
      const app = new Hono();
      mountStatic(app, dir, 'the-real-token');
      const res = await app.fetch(new Request('http://localhost/'));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('the-real-token');
      expect(html).not.toContain(PLACEHOLDER);
    } finally {
      await removeTempDir(dir);
    }
  });

  test('the SPA catch-all also substitutes the token for an unknown client route', async () => {
    const dir = await makeTempDir('review-ui-static-dist-');
    try {
      await makeWebDist(dir);
      const app = new Hono();
      mountStatic(app, dir, 'the-real-token');
      const res = await app.fetch(new Request('http://localhost/reviews/abc123'));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('the-real-token');
      expect(html).not.toContain(PLACEHOLDER);
    } finally {
      await removeTempDir(dir);
    }
  });

  test('/api paths are not swallowed by the SPA catch-all (404, not the index page)', async () => {
    const dir = await makeTempDir('review-ui-static-dist-');
    try {
      await makeWebDist(dir);
      const app = new Hono();
      mountStatic(app, dir, 'the-real-token');
      const res = await app.fetch(new Request('http://localhost/api/some-unmounted-path'));
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain('<!doctype html>');
    } finally {
      await removeTempDir(dir);
    }
  });

  test('a rotated token is picked up on the very next request without a restart (reads the file per request)', async () => {
    const dir = await makeTempDir('review-ui-static-dist-');
    try {
      await makeWebDist(dir);
      const app = new Hono();
      mountStatic(app, dir, 'token-one');
      const first = await app.fetch(new Request('http://localhost/'));
      expect(await first.text()).toContain('token-one');

      // Rewrite index.html as if a fresh build had happened, and remount
      // with a different token to simulate rotation.
      await writeFile(join(dir, 'index.html'), `<!doctype html><html><body>${PLACEHOLDER}</body></html>`);
      const app2 = new Hono();
      mountStatic(app2, dir, 'token-two');
      const second = await app2.fetch(new Request('http://localhost/'));
      const html = await second.text();
      expect(html).toContain('token-two');
      expect(html).not.toContain('token-one');
    } finally {
      await removeTempDir(dir);
    }
  });

  test('static assets under the dist dir are served as-is (no token substitution)', async () => {
    const dir = await makeTempDir('review-ui-static-dist-');
    try {
      await makeWebDist(dir);
      const app = new Hono();
      mountStatic(app, dir, 'the-real-token');
      const res = await app.fetch(new Request('http://localhost/assets/app.js'));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('console.log');
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('static.ts: without a built web dist', () => {
  test('serves the fallback page when dist does not exist', async () => {
    const dir = await makeTempDir('review-ui-static-missing-');
    await rm(dir, { recursive: true, force: true }); // ensure it truly doesn't exist
    try {
      const app = new Hono();
      mountStatic(app, dir, 'whatever-token');
      const res = await app.fetch(new Request('http://localhost/'));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('review-ui server is running');
    } finally {
      // dir was already removed; nothing to clean up.
    }
  });

  test('/api paths are not swallowed by the fallback catch-all either', async () => {
    const dir = await makeTempDir('review-ui-static-missing-');
    await rm(dir, { recursive: true, force: true });
    try {
      const app = new Hono();
      mountStatic(app, dir, 'whatever-token');
      const res = await app.fetch(new Request('http://localhost/api/whatever'));
      expect(res.status).toBe(404);
    } finally {
      // nothing to clean up
    }
  });
});
