import { describe, expect, test } from 'bun:test';
import { PlanValidationError, parsePlan } from '../src/plan.ts';

describe('parsePlan', () => {
  test('accepts a valid plan and applies defaults', () => {
    const plan = parsePlan({
      steps: [{ title: 'Read the schema change', files: [{ path: 'packages/core/src/domain/review.ts' }] }],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.guidance).toBe('');
    expect(plan.steps[0]?.files[0]?.note).toBeNull();
  });

  test('rejects a plan with zero steps', () => {
    expect(() => parsePlan({ steps: [] })).toThrow(PlanValidationError);
  });

  test('reports the offending path for a bad nested field, not a raw zod dump', () => {
    try {
      parsePlan({
        steps: [
          { title: 'ok', files: [{ path: 'a.ts' }] },
          { title: 'bad step', files: [{ path: '' }] },
        ],
      });
      throw new Error('expected parsePlan to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      const message = (err as PlanValidationError).message;
      expect(message).toContain('steps[1].files[0].path');
    }
  });

  test('reports a missing required field with its path', () => {
    try {
      parsePlan({ steps: [{ files: [{ path: 'a.ts' }] }] });
      throw new Error('expected parsePlan to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      expect((err as PlanValidationError).message).toContain('steps[0].title');
    }
  });

  test('rejects non-object input', () => {
    expect(() => parsePlan('not a plan')).toThrow(PlanValidationError);
  });
});
