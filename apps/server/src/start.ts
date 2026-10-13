/**
 * Server startup (`startServer`, shared by `bun src/index.ts` and `joinery serve`): run migrations, ensure the data dir and
 * bearer token, start the HTTP + WS server bound to `127.0.0.1` only, log
 * the URL, and dispose engines/cat-file processes cleanly on shutdown. Also
 * fails agent runs orphaned by the previous process and keeps the agent
 * worktree cache pruned (`agent/maintenance.ts`), and the git/`gh` answer
 * cache too (`storedCache.ts`).
 */
import { DEFAULT_HOST, DEFAULT_PORT } from '@joinery/core';
import { initDataDir, openDb, readToken, runMigrations } from './db/index.ts';
import { EngineRegistry } from './engine/index.ts';
import { createApp } from './http/app.ts';
import { failOrphanedRuns, startWorktreeSweep } from './agent/maintenance.ts';
import { startCacheEntryPrune } from './storedCache.ts';
import { runtimeLayout } from './runtime.ts';

export async function startServer(): Promise<void> {
  const paths = await initDataDir();
  const { db, sqlite } = openDb({ file: paths.dbFile });
  await runMigrations(sqlite, { log: (message) => console.log(`[migrate] ${message}`) });

  const token = await readToken(paths);

  const orphaned = await failOrphanedRuns(db);
  if (orphaned > 0) console.log(`[runs] marked ${String(orphaned)} run(s) interrupted by the last shutdown as errored`);
  const stopWorktreeSweep = startWorktreeSweep(db);
  const stopCacheEntryPrune = startCacheEntryPrune(db);

  const registry = new EngineRegistry(db);
  const layout = runtimeLayout();
  const webDistDir = layout.webDistDir;

  const { app, websocket } = createApp({ db, registry, token, webDistDir });

  const host = process.env['JOINERY_HOST']?.trim() || DEFAULT_HOST;
  const port = Number(process.env['JOINERY_PORT']?.trim() || DEFAULT_PORT);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: app.fetch,
    websocket,
  });

  console.log(`joinery ${layout.version} listening on http://${host}:${String(port)}`);
  console.log(`data dir: ${paths.root}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('shutting down...');
    stopWorktreeSweep();
    stopCacheEntryPrune();
    registry.disposeAll();
    server.stop();
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
