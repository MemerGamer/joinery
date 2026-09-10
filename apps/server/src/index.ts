/**
 * Server entrypoint (SPEC §3, §10): run migrations, ensure the data dir and
 * bearer token, start the HTTP + WS server bound to `127.0.0.1` only, log
 * the URL, and dispose engines/cat-file processes cleanly on shutdown.
 */
import { resolve } from 'node:path';
import { DEFAULT_HOST, DEFAULT_PORT } from '@review/core';
import { initDataDir, openDb, readToken, runMigrations } from './db/index.ts';
import { EngineRegistry } from './engine/index.ts';
import { createApp } from './http/app.ts';

async function main(): Promise<void> {
  const paths = await initDataDir();
  const { db, sqlite } = openDb({ file: paths.dbFile });
  await runMigrations(sqlite, { log: (message) => console.log(`[migrate] ${message}`) });

  const token = await readToken(paths);

  const registry = new EngineRegistry(db);
  const webDistDir = resolve(import.meta.dirname, '..', '..', 'web', 'dist');

  const { app, websocket } = createApp({ db, registry, token, webDistDir });

  const host = process.env['REVIEW_HOST']?.trim() || DEFAULT_HOST;
  const port = Number(process.env['REVIEW_PORT']?.trim() || DEFAULT_PORT);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: app.fetch,
    websocket,
  });

  console.log(`review-ui server listening on http://${host}:${String(port)}`);
  console.log(`data dir: ${paths.root}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('shutting down...');
    registry.disposeAll();
    server.stop();
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
