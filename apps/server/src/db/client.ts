/**
 * Opens the SQLite database and returns a typed drizzle instance bound to
 * `@review/core`'s schema (the single source of truth for tables).
 */
import { Database } from 'bun:sqlite';
import { schema } from '@review/core/db';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type Db = BunSQLiteDatabase<typeof schema>;

export type OpenDbOptions = {
  /** Path to the sqlite file, or `:memory:` for tests. */
  readonly file: string;
};

/** Pragmas that matter for a single-writer, many-reader local app. */
function applyPragmas(sqlite: Database): void {
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA synchronous = NORMAL');
}

export type OpenedDb = {
  readonly db: Db;
  readonly sqlite: Database;
};

/** Open the database at `file`, set pragmas, and return a typed drizzle instance. */
export function openDb(options: OpenDbOptions): OpenedDb {
  if (options.file !== ':memory:') {
    mkdirSync(dirname(options.file), { recursive: true });
  }
  const sqlite = new Database(options.file, { create: true });
  applyPragmas(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
