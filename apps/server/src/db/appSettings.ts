/**
 * `app_setting` — app-wide preferences the user chose, as JSON by key. Each
 * caller owns its keys and validates what it reads back.
 */
import { appSetting } from '@joinery/core/db';
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';

export async function getAppSetting(db: Db, key: string): Promise<unknown> {
  const rows = await db.select().from(appSetting).where(eq(appSetting.key, key)).limit(1);
  const row = rows[0];
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

export async function putAppSetting(db: Db, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await db.insert(appSetting).values({ key, value: json }).onConflictDoUpdate({ target: appSetting.key, set: { value: json } });
}
