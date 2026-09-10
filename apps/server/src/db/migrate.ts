/**
 * A small, hand-rolled migration runner — not `drizzle-kit push`, never
 * auto-migrate. Applies numbered `.sql` files from `apps/server/migrations`
 * in order, inside a transaction each, tracked in a `schema_migrations`
 * table. Safe to call on every server start: already-applied files are
 * skipped.
 */
import type { Database } from 'bun:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `apps/server/migrations`, resolved relative to this file. */
const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

const MIGRATION_FILE_RE = /^(\d+)_.+\.sql$/;

export type MigrationLogger = (message: string) => void;

async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort((a, b) => {
      const na = Number(MIGRATION_FILE_RE.exec(a)?.[1]);
      const nb = Number(MIGRATION_FILE_RE.exec(b)?.[1]);
      return na - nb;
    });
}

/**
 * Apply every migration in `migrationsDir` (default: `apps/server/migrations`)
 * that is not already recorded in `schema_migrations`, each inside its own
 * transaction. Idempotent: running it twice applies nothing the second time.
 */
export async function runMigrations(
  sqlite: Database,
  options: { readonly migrationsDir?: string; readonly log?: MigrationLogger } = {},
): Promise<string[]> {
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY NOT NULL,
       applied_at integer NOT NULL DEFAULT (unixepoch())
     )`,
  );

  const already = new Set(
    sqlite.query<{ name: string }, []>('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );

  const files = await listMigrationFiles(migrationsDir);
  const applied: string[] = [];

  for (const file of files) {
    if (already.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const run = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.query('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
    run();

    applied.push(file);
    log(`applied migration ${file}`);
  }

  if (applied.length === 0) log('no pending migrations');

  return applied;
}
