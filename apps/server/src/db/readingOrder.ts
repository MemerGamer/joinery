/**
 * `reading_order` + `step` + `step_file` (§7). Regenerating writes a **new
 * version** rather than replacing: old versions are retained, so progress and
 * threads survive a regenerate (§13.3).
 */
import { readingOrder, step, stepFile } from '@review/core/db';
import type { ReadingOrder, ReadingOrderPlan, Step } from '@review/core';
import { desc, eq, inArray, max } from 'drizzle-orm';
import { readingOrderId, stepId } from '@review/core';
import type { Db } from './client.ts';

/** Write `plan` as a new version for `reviewId`. Never replaces an existing version. */
export async function writeReadingOrderPlan(
  db: Db,
  reviewId: string,
  plan: ReadingOrderPlan,
  agentRunId: string | null = null,
): Promise<ReadingOrder> {
  return db.transaction((tx) => {
    const maxVersionRows = tx
      .select({ maxVersion: max(readingOrder.version) })
      .from(readingOrder)
      .where(eq(readingOrder.reviewId, reviewId))
      .all();
    const version = (maxVersionRows[0]?.maxVersion ?? 0) + 1;

    const roRows = tx
      .insert(readingOrder)
      .values({ id: readingOrderId(), reviewId, version, agentRunId })
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
          explanationMd: planStep.explanation_md,
        })
        .run();

      planStep.files.forEach((f, fileIdx) => {
        tx.insert(stepFile)
          .values({ stepId: sId, idx: fileIdx, path: f.path, noteMd: f.note_md })
          .run();
      });

      steps.push({
        id: sId,
        idx: stepIdx,
        title: planStep.title,
        explanationMd: planStep.explanation_md,
        files: planStep.files.map((f) => ({ path: f.path, noteMd: f.note_md })),
      });
    });

    return {
      id: roRow.id,
      reviewId: roRow.reviewId,
      version: roRow.version,
      agentRunId: roRow.agentRunId,
      createdAt: roRow.createdAt,
      steps,
      unassignedPaths: [],
    };
  });
}

/**
 * Read the latest reading-order version for `reviewId`, with its steps and
 * step files assembled, and `unassignedPaths` computed against `currentPaths`
 * — files present in the review but belonging to no step.
 */
export async function getLatestReadingOrder(
  db: Db,
  reviewId: string,
  currentPaths: readonly string[] = [],
): Promise<ReadingOrder | null> {
  const roRows = await db
    .select()
    .from(readingOrder)
    .where(eq(readingOrder.reviewId, reviewId))
    .orderBy(desc(readingOrder.version))
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
    list.push({ path: row.path, noteMd: row.noteMd });
    filesByStep.set(row.stepId, list);
  }

  const steps: Step[] = stepRows.map((row) => ({
    id: row.id,
    idx: row.idx,
    title: row.title,
    explanationMd: row.explanationMd,
    files: filesByStep.get(row.id) ?? [],
  }));

  const assigned = new Set(stepFileRows.map((r) => r.path));
  const unassignedPaths = currentPaths.filter((p) => !assigned.has(p));

  return {
    id: roRow.id,
    reviewId: roRow.reviewId,
    version: roRow.version,
    agentRunId: roRow.agentRunId,
    createdAt: roRow.createdAt,
    steps,
    unassignedPaths,
  };
}
