/**
 * "How much of me will this review take" — files carry more weight than
 * lines (a 40-file rename is harder to hold in your head than one 400-line
 * file), bucketed into four levels. Moved out of `mock/homebase.ts`
 * unchanged in behaviour, generalized to the nullable fields
 * `ReviewSummary` actually carries (a head that can't be resolved reports
 * `null` diff stats rather than zeros).
 */

export type EffortLevel = 1 | 2 | 3 | 4;

export interface Effort {
  level: EffortLevel;
  label: string;
  /** Rough minutes, rounded to 5 (minimum 5). */
  minutes: number;
  /** Raw score, for ordering. */
  score: number;
}

const LABELS: readonly [string, string, string, string] = ['Light', 'Moderate', 'Heavy', 'Marathon'];

export function effortOf(
  x: { filesTotal?: number | null; additions: number | null; deletions: number | null },
  files: number | null | undefined = x.filesTotal,
): Effort {
  const lines = (x.additions ?? 0) + (x.deletions ?? 0);
  const fileCount = files ?? Math.max(1, Math.round(lines / 60));
  const score = fileCount * 1.5 + lines / 60;
  const level: EffortLevel = score < 15 ? 1 : score < 40 ? 2 : score < 90 ? 3 : 4;
  const label = LABELS[level - 1] ?? 'Light';
  const minutes = Math.max(5, Math.round((score * 1.6) / 5) * 5);
  return { level, label, minutes, score };
}
