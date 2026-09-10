/**
 * Validation for the `plan.json` file consumed by `review reading-order set`.
 * Kept separate from the command module so it can be unit tested without
 * touching the network or the filesystem.
 */
import { readingOrderPlanSchema, type ReadingOrderPlan } from '@review/core';
import type { z } from 'zod';

/** Thrown when `plan.json` fails validation. `message` is ready to print. */
export class PlanValidationError extends Error {
  override readonly name = 'PlanValidationError';
}

/** Renders a zod issue path like `steps[2].files[0].path` instead of a raw dump. */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      const key = String(segment);
      out = out.length === 0 ? key : `${out}.${key}`;
    }
  }
  return out.length > 0 ? out : '(root)';
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join('\n');
}

/**
 * Parses and validates `raw` (already-`JSON.parse`d plan file content)
 * against `readingOrderPlanSchema`. Throws `PlanValidationError` with one
 * line per problem, each naming the offending path, on failure.
 */
export function parsePlan(raw: unknown): ReadingOrderPlan {
  const result = readingOrderPlanSchema.safeParse(raw);
  if (!result.success) {
    throw new PlanValidationError(formatZodError(result.error));
  }
  return result.data;
}
