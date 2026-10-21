/**
 * `review_state` — what the engine last worked out for a review's `head`
 * revision (`engine/reviewState.ts` is the only writer). Every write that
 * changes something bumps `version`.
 */
import { reviewState } from '@joinery/core/db';
import { headSourceSchema, pullDetailSchema, type HeadSource, type PullDetail } from '@joinery/core';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';
import { narrowUnion } from './narrow.ts';

export type StoredReviewState = {
  readonly reviewId: string;
  readonly version: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly headSource: HeadSource;
  readonly merged: boolean;
  readonly filesTotal: number;
  readonly additions: number;
  readonly deletions: number;
  readonly blobByPath: Readonly<Record<string, string>>;
  readonly subject: string | null;
  readonly authorName: string | null;
  readonly committedAt: number | null;
  readonly pull: PullDetail | null;
  readonly pullHeadSha: string | null;
  readonly pullUpdatedAt: string | null;
  readonly mergedBaseSha: string | null;
};

/** Everything but the bookkeeping the store owns. */
export type ReviewStateFields = Omit<StoredReviewState, 'reviewId' | 'version'>;

function parsePull(json: string | null): PullDetail | null {
  if (json === null) return null;
  try {
    const parsed = pullDetailSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseBlobs(json: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function toState(row: typeof reviewState.$inferSelect): StoredReviewState {
  return {
    reviewId: row.reviewId,
    version: row.version,
    headSha: row.headSha,
    baseSha: row.baseSha,
    headSource: narrowUnion(row.headSource, headSourceSchema.options, 'review_state.head_source'),
    merged: row.merged,
    filesTotal: row.filesTotal,
    additions: row.additions,
    deletions: row.deletions,
    blobByPath: parseBlobs(row.blobByPath),
    subject: row.subject,
    authorName: row.authorName,
    committedAt: row.committedAt,
    pull: parsePull(row.pull),
    pullHeadSha: row.pullHeadSha,
    pullUpdatedAt: row.pullUpdatedAt,
    mergedBaseSha: row.mergedBaseSha,
  };
}

export async function getReviewState(db: Db, reviewId: string): Promise<StoredReviewState | null> {
  const rows = await db.select().from(reviewState).where(eq(reviewState.reviewId, reviewId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toState(row);
}

export async function listReviewStates(db: Db, reviewIds: readonly string[]): Promise<Map<string, StoredReviewState>> {
  if (reviewIds.length === 0) return new Map();
  const rows = await db.select().from(reviewState).where(inArray(reviewState.reviewId, [...reviewIds]));
  return new Map(rows.map((row) => [row.reviewId, toState(row)]));
}

/** Writes `fields` as the next version; returns it. */
export async function putReviewState(
  db: Db,
  reviewId: string,
  fields: ReviewStateFields,
  previousVersion: number | null,
): Promise<StoredReviewState> {
  const version = (previousVersion ?? 0) + 1;
  const values = {
    version,
    headSha: fields.headSha,
    baseSha: fields.baseSha,
    headSource: fields.headSource,
    merged: fields.merged,
    filesTotal: fields.filesTotal,
    additions: fields.additions,
    deletions: fields.deletions,
    blobByPath: JSON.stringify(fields.blobByPath),
    subject: fields.subject,
    authorName: fields.authorName,
    committedAt: fields.committedAt,
    pull: fields.pull === null ? null : JSON.stringify(fields.pull),
    pullHeadSha: fields.pullHeadSha,
    pullUpdatedAt: fields.pullUpdatedAt,
    mergedBaseSha: fields.mergedBaseSha,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await db
    .insert(reviewState)
    .values({ reviewId, ...values })
    .onConflictDoUpdate({ target: reviewState.reviewId, set: values });
  return { reviewId, version, ...fields };
}
