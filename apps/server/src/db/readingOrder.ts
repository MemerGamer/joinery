/**
 * `reading_order` + `step` + `step_file`. A review has at most one reading
 * order: writing a plan deletes the old one (steps and files cascade) and
 * inserts the new one in the same transaction. Progress and threads hang off
 * the review and file paths, not the reading order, so they survive.
 */
import { readingOrder, step, stepFile } from '@joinery/core/db';
import type { ReadingOrder, ReadingOrderPlan, Step } from '@joinery/core';
import { eq, inArray } from 'drizzle-orm';
import { readingOrderId, stepId } from '@joinery/core';
import type { Db } from './client.ts';

/** Write `plan` as the reading order for `reviewId`, replacing any existing one. */
export async function writeReadingOrderPlan(
  db: Db,
  reviewId: string,
  plan: ReadingOrderPlan,
  agentRunId: string | null = null,
): Promise<ReadingOrder> {
  return db.transaction((tx) => {
    tx.delete(readingOrder).where(eq(readingOrder.reviewId, reviewId)).run();

    const roRows = tx
      .insert(readingOrder)
      .values({ id: readingOrderId(), reviewId, agentRunId })
      .returning()
      .all();
    const roRow = roRows[0];
    if (roRow === undefined) throw new Error('writeReadingOrderPlan: insert returned no row');

    const steps: Step[] = [];
    plan.steps.forEach((planStep, stepIdx) => {
      const sId = stepId();
      tx.insert(step)
        .values({
          id: sId,
          readingOrderId: roRow.id,
          idx: stepIdx,
          title: planStep.title,
          guidance: planStep.guidance,
          attention: planStep.attention,
        })
        .run();

      planStep.files.forEach((f, fileIdx) => {
        tx.insert(stepFile)
          .values({ stepId: sId, idx: fileIdx, path: f.path, note: f.note })
          .run();
      });

      steps.push({
        id: sId,
        idx: stepIdx,
        title: planStep.title,
        guidance: planStep.guidance,
        attention: planStep.attention,
        files: planStep.files.map((f) => ({ path: f.path, note: f.note })),
      });
    });

    return {
      id: roRow.id,
      reviewId: roRow.reviewId,
      agentRunId: roRow.agentRunId,
      createdAt: roRow.createdAt,
      steps,
      unassignedPaths: [],
    };
  });
}

/**
 * Read the reading order for `reviewId`, with its steps and
 * step files assembled, and `unassignedPaths` computed against `currentPaths`
 * — files present in the review but belonging to no step.
 */
export async function getReadingOrder(
  db: Db,
  reviewId: string,
  currentPaths: readonly string[] = [],
): Promise<ReadingOrder | null> {
  const roRows = await db
    .select()
    .from(readingOrder)
    .where(eq(readingOrder.reviewId, reviewId))
    .limit(1);
  const roRow = roRows[0];
  if (roRow === undefined) return null;

  const stepRows = await db
    .select()
    .from(step)
    .where(eq(step.readingOrderId, roRow.id))
    .orderBy(step.idx);

  const stepIds = stepRows.map((s) => s.id);
  const stepFileRows =
    stepIds.length === 0
      ? []
      : await db.select().from(stepFile).where(inArray(stepFile.stepId, stepIds)).orderBy(stepFile.idx);

  const filesByStep = new Map<string, Step['files']>();
  for (const row of stepFileRows) {
    const list = filesByStep.get(row.stepId) ?? [];
    list.push({ path: row.path, note: row.note });
    filesByStep.set(row.stepId, list);
  }

  const steps: Step[] = stepRows.map((row) => ({
    id: row.id,
    idx: row.idx,
    title: row.title,
    guidance: row.guidance,
    attention: row.attention === 'focus' || row.attention === 'skim' ? row.attention : null,
    files: filesByStep.get(row.id) ?? [],
  }));

  const assigned = new Set(stepFileRows.map((r) => r.path));
  const unassignedPaths = currentPaths.filter((p) => !assigned.has(p));

  return {
    id: roRow.id,
    reviewId: roRow.reviewId,
    agentRunId: roRow.agentRunId,
    createdAt: roRow.createdAt,
    steps,
    unassignedPaths,
  };
}
