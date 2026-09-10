/**
 * Serves the built web app from `apps/web/dist` when it exists (SPEC §10),
 * falling back to a clear message when it doesn't — the web app is being
 * built concurrently by another agent, so this module must not assume its
 * files exist.
 */
import type { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FALLBACK_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>review-ui</title></head>
  <body style="font: 14px -apple-system, sans-serif; max-width: 640px; margin: 4rem auto; line-height: 1.5;">
    <h1>review-ui server is running</h1>
    <p>The web app hasn't been built yet — <code>apps/web/dist</code> doesn't exist.</p>
    <p>The HTTP API is live under <code>/api/*</code> (bearer token required).</p>
  </body>
</html>
`;

export function mountStatic(app: Hono, webDistDir: string): void {
  const hasWebDist = existsSync(join(webDistDir, 'index.html'));

  if (hasWebDist) {
    app.use('/*', serveStatic({ root: webDistDir }));
    app.get('*', serveStatic({ path: join(webDistDir, 'index.html') }));
    return;
  }

  app.get('*', (c) => {
    if (c.req.path.startsWith('/api')) return c.notFound();
    return c.html(FALLBACK_HTML);
  });
}
