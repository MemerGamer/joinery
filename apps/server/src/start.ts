/**
 * Server startup (`startServer`, shared by `bun src/index.ts` and `joinery serve`): run migrations, ensure the data dir and
 * bearer token, start the HTTP + WS server bound to `127.0.0.1` only, log
 * the URL, and dispose engines, cat-file processes and language servers cleanly
 * on shutdown. Also fails agent runs orphaned by the previous process and keeps the agent
 * worktree cache pruned (`agent/maintenance.ts`), and the git/`gh` answer
 * cache too (`storedCache.ts`).
 */
import { DEFAULT_HOST } from '@joinery/core';
import { initDataDir, openDb, readToken, runMigrations } from './db/index.ts';
import { EngineRegistry } from './engine/index.ts';
import { createApp } from './http/app.ts';
import { failOrphanedRuns, startWorktreeSweep } from './agent/maintenance.ts';
import { startCacheEntryPrune } from './storedCache.ts';
import { lsp } from './lsp/index.ts';
import { loadLspChoices } from './lsp/choices.ts';
import { lspViews } from './lsp/views.ts';
import { configuredPort, portFile, runtimeLayout } from './runtime.ts';

export async function startServer(): Promise<void> {
  const paths = await initDataDir();
  const { db, sqlite } = openDb({ file: paths.dbFile });
  await runMigrations(sqlite, { log: (message) => console.log(`[migrate] ${message}`) });
  await loadLspChoices(db);

  const token = await readToken(paths);

  const orphaned = await failOrphanedRuns(db);
  if (orphaned > 0) console.log(`[runs] marked ${String(orphaned)} run(s) interrupted by the last shutdown as errored`);
  const stopWorktreeSweep = startWorktreeSweep(db);
  const stopCacheEntryPrune = startCacheEntryPrune(db);

  const registry = new EngineRegistry(db);
  registry.setViewListener(lspViews);
  const layout = runtimeLayout();
  const webDistDir = layout.webDistDir;

  const { app, websocket } = createApp({ db, registry, token, webDistDir });

  const host = process.env['JOINERY_HOST']?.trim() || DEFAULT_HOST;
  const port = configuredPort();

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: host,
      port,
      fetch: app.fetch,
      websocket,
    });
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EADDRINUSE') throw err;
    throw new Error(
      `port ${String(port)} is already in use (see \`lsof -i :${String(port)}\`); ` +
        `set another in ${portFile()} or with JOINERY_PORT`,
    );
  }

  // Topics publish through the server; polling starts once they can.
  registry.bus.attach(server);
  await registry.pollers.start();

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
    // Language servers get a moment to exit cleanly, never long enough to hold up the stop.
    void Promise.race([lsp.stopAll(), Bun.sleep(1_000)]).then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
