/**
 * "How much of me will this review take", in minutes, bucketed into four
 * levels. Calibrated against published review-speed data:
 *
 * - Careful inspection runs at roughly 300–500 changed lines an hour
 *   (SmartBear/Cisco), so the first 400 lines cost 0.15 min each. Past that,
 *   real reviews of large (often generated) PRs turn into reading and then
 *   skimming, so lines get cheaper: 0.09 min up to 2,000, 0.05 beyond.
 * - Deletions count for a quarter of an addition: there's less to check in
 *   code that's going away.
 * - Each file adds 0.75 min of context switching; file count predicts
 *   review time better than line count does.
 *
 * Takes the nullable fields `ReviewSummary` carries (a head that can't be
 * resolved reports `null` diff stats rather than zeros).
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

/** [lines in this tier, minutes per line]: careful, normal, skim. */
const LINE_TIERS: readonly (readonly [number, number])[] = [
  [400, 0.15],
  [1600, 0.09],
  [Infinity, 0.05],
];
const DELETION_WEIGHT = 0.25;
const MINUTES_PER_FILE = 0.75;

export function effortOf(
  x: { filesTotal?: number | null; additions: number | null; deletions: number | null },
  files: number | null | undefined = x.filesTotal,
): Effort {
  const additions = x.additions ?? 0;
  const deletions = x.deletions ?? 0;
  const fileCount = files ?? Math.max(1, Math.round((additions + deletions) / 60));

  let rest = additions + DELETION_WEIGHT * deletions;
  let lineMinutes = 0;
  for (const [cap, rate] of LINE_TIERS) {
    const n = Math.min(rest, cap);
    lineMinutes += n * rate;
    rest -= n;
  }
  const score = fileCount * MINUTES_PER_FILE + lineMinutes;
  const minutes = Math.max(5, Math.round(score / 5) * 5);
  const level: EffortLevel = minutes < 15 ? 1 : minutes < 60 ? 2 : minutes < 180 ? 3 : 4;
  const label = LABELS[level - 1] ?? 'Light';
  return { level, label, minutes, score };
}
