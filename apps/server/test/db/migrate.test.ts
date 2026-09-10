import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/db/migrate.ts';

describe('runMigrations', () => {
  test('applies all migrations and is idempotent when run twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-ui-migrate-test-'));
    try {
      const sqlite = new Database(join(dir, 'state.sqlite'), { create: true });

      const first = await runMigrations(sqlite);
      expect(first).toEqual(['0001_init.sql', '0002_revision_choice.sql']);

      const tables = sqlite
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
        .sort();
      expect(tables).toContain('repo');
      expect(tables).toContain('review');
      expect(tables).toContain('thread');
      expect(tables).toContain('agent_event');
      expect(tables).toContain('schema_migrations');

      // Running again must not error and must apply nothing further.
      const second = await runMigrations(sqlite);
      expect(second).toEqual([]);

      const applied = sqlite
        .query<{ name: string }, []>('SELECT name FROM schema_migrations')
        .all()
        .map((r) => r.name);
      expect(applied).toEqual(['0001_init.sql', '0002_revision_choice.sql']);

      sqlite.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
