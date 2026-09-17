/**
 * Mock data for the Homebase / Explore UI exploration.
 *
 * Deliberately richer than what `GET /api/reviews` returns today: the point
 * of this pass is to find out which facts a dashboard actually wants before
 * deciding what the server should aggregate. Everything here is a candidate
 * for `ReviewSummary`; nothing here is wired to the API.
 */

const now = Math.floor(Date.now() / 1000);
const m = (n: number): number => now - n * 60;
const h = (n: number): number => now - n * 3600;
const d = (n: number): number => now - n * 86400;

export interface Person {
  name: string;
  initials: string;
  /** Hue for the avatar tint; the CSS derives light/dark colours from it. */
  hue: number;
  /** Agents get a robot glyph instead of initials. */
  agent?: boolean;
}

export const YOU: Person = { name: 'Szabi', initials: 'SN', hue: 240 };
export const PEOPLE = {
  you: YOU,
  mara: { name: 'Mara Lindqvist', initials: 'ML', hue: 340 },
  theo: { name: 'Theo Adeyemi', initials: 'TA', hue: 160 },
  june: { name: 'June Park', initials: 'JP', hue: 30 },
  claude: { name: 'Claude', initials: 'CL', hue: 270, agent: true },
} as const satisfies Record<string, Person>;

export interface MockRepo {
  id: string;
  name: string;
  slug: string;
  rootPath: string;
  defaultBranch: string;
  lastFetchedAt: number;
}

export const REPOS: MockRepo[] = [
  { id: 'r1', name: 'review-ui', slug: 'szabi/review-ui', rootPath: '~/coding/review-ui', defaultBranch: 'main', lastFetchedAt: m(4) },
  { id: 'r2', name: 'atlas-api', slug: 'northwind/atlas-api', rootPath: '~/coding/atlas-api', defaultBranch: 'main', lastFetchedAt: m(12) },
  { id: 'r3', name: 'billing-worker', slug: 'northwind/billing-worker', rootPath: '~/coding/billing-worker', defaultBranch: 'develop', lastFetchedAt: h(3) },
  { id: 'r4', name: 'design-tokens', slug: 'szabi/design-tokens', rootPath: '~/coding/design-tokens', defaultBranch: 'main', lastFetchedAt: d(2) },
];

export type Bucket = 'attention' | 'done';

export type Ci = 'passing' | 'failing' | 'pending' | null;

export interface MockReview {
  id: string;
  repoId: string;
  branch: string;
  prNumber: number | null;
  /** PR title, or the tip commit's subject for a plain branch. */
  title: string;
  author: Person;
  baseRef: string;
  draft: boolean;
  ci: Ci;
  filesTotal: number;
  filesViewed: number;
  additions: number;
  deletions: number;
  openThreads: number;
  resolvedThreads: number;
  /** Agent replies you haven't read yet. */
  unreadReplies: number;
  /** Commits that landed on the head since you last looked. */
  newCommits: number;
  uncommittedFiles: number;
  readingOrder: { version: number; steps: number } | null;
  agent: null | null;
  lastActivityAt: number;
  createdAt: number;
  bucket: Bucket;
}

export const REVIEWS: MockReview[] = [
  {
    id: 'v1', repoId: 'r2', branch: 'feat/rate-limit-middleware', prNumber: 418,
    title: 'Token-bucket rate limiting for public endpoints',
    author: PEOPLE.mara, baseRef: 'main', draft: false, ci: 'passing',
    filesTotal: 23, filesViewed: 9, additions: 612, deletions: 148,
    openThreads: 3, resolvedThreads: 2, unreadReplies: 2, newCommits: 0, uncommittedFiles: 0,
    readingOrder: { version: 2, steps: 5 }, agent: null,
    lastActivityAt: m(38), createdAt: d(2), bucket: 'attention',
  },
  {
    id: 'v2', repoId: 'r1', branch: 'feat/explore-repos-branches-prs', prNumber: 61,
    title: 'Explore screen, review archiving, and Homebase redesign',
    author: PEOPLE.you, baseRef: 'main', draft: false, ci: 'pending',
    filesTotal: 20, filesViewed: 0, additions: 1906, deletions: 131,
    openThreads: 0, resolvedThreads: 0, unreadReplies: 0, newCommits: 3, uncommittedFiles: 2,
    readingOrder: null, agent: null,
    lastActivityAt: h(1), createdAt: h(6), bucket: 'attention',
  },
  {
    id: 'v3', repoId: 'r3', branch: 'fix/invoice-rounding', prNumber: 92,
    title: 'Round invoice line totals once, at the end',
    author: PEOPLE.theo, baseRef: 'develop', draft: false, ci: 'failing',
    filesTotal: 6, filesViewed: 4, additions: 74, deletions: 31,
    openThreads: 1, resolvedThreads: 4, unreadReplies: 1, newCommits: 2, uncommittedFiles: 0,
    readingOrder: { version: 1, steps: 3 }, agent: null,
    lastActivityAt: h(3), createdAt: d(4), bucket: 'attention',
  },
  {
    id: 'v4', repoId: 'r2', branch: 'refactor/session-store', prNumber: 421,
    title: 'Move session store behind an interface',
    author: PEOPLE.june, baseRef: 'main', draft: true, ci: 'passing',
    filesTotal: 41, filesViewed: 0, additions: 1210, deletions: 980,
    openThreads: 0, resolvedThreads: 0, unreadReplies: 0, newCommits: 0, uncommittedFiles: 0,
    readingOrder: null,
    agent: null,
    lastActivityAt: m(3), createdAt: m(9), bucket: 'attention',
  },
  {
    id: 'v5', repoId: 'r1', branch: 'agent/threads-panel-polish', prNumber: null,
    title: 'Polish threads panel and remove a focus-ring glitch',
    author: PEOPLE.claude, baseRef: 'main', draft: false, ci: null,
    filesTotal: 4, filesViewed: 4, additions: 96, deletions: 40,
    openThreads: 1, resolvedThreads: 3, unreadReplies: 0, newCommits: 0, uncommittedFiles: 0,
    readingOrder: { version: 1, steps: 2 },
    agent: null,
    lastActivityAt: m(1), createdAt: d(1), bucket: 'attention',
  },
  {
    id: 'v6', repoId: 'r3', branch: 'feat/dunning-emails', prNumber: 88,
    title: 'Dunning email sequence with per-tenant templates',
    author: PEOPLE.mara, baseRef: 'develop', draft: false, ci: 'passing',
    filesTotal: 17, filesViewed: 17, additions: 402, deletions: 12,
    openThreads: 2, resolvedThreads: 5, unreadReplies: 0, newCommits: 0, uncommittedFiles: 0,
    readingOrder: { version: 1, steps: 4 }, agent: null,
    lastActivityAt: h(7), createdAt: d(3), bucket: 'attention',
  },
  {
    id: 'v7', repoId: 'r2', branch: 'chore/openapi-3.1', prNumber: 415,
    title: 'Regenerate clients from the OpenAPI 3.1 spec',
    author: PEOPLE.theo, baseRef: 'main', draft: false, ci: 'passing',
    filesTotal: 58, filesViewed: 58, additions: 3100, deletions: 2870,
    openThreads: 1, resolvedThreads: 1, unreadReplies: 0, newCommits: 0, uncommittedFiles: 0,
    readingOrder: { version: 1, steps: 3 }, agent: null,
    lastActivityAt: d(1), createdAt: d(5), bucket: 'attention',
  },
  {
    id: 'v8', repoId: 'r4', branch: 'feat/semantic-spacing', prNumber: 12,
    title: 'Semantic spacing scale and Figma sync',
    author: PEOPLE.you, baseRef: 'main', draft: false, ci: 'passing',
    filesTotal: 9, filesViewed: 9, additions: 210, deletions: 66,
    openThreads: 0, resolvedThreads: 6, unreadReplies: 0, newCommits: 0, uncommittedFiles: 0,
    readingOrder: { version: 1, steps: 3 }, agent: null,
    lastActivityAt: d(1), createdAt: d(6), bucket: 'done',
  },
  {
    id: 'v9', repoId: 'r1', branch: 'fix/diff-context-expansion', prNumber: 57,
    title: 'Shrink the unchanged-context expansion step to 20 lines',
    author: PEOPLE.claude, baseRef: 'main', draft: false, ci: 'passing',
    filesTotal: 2, filesViewed: 2, additions: 18, deletions: 9,
    openThreads: 0, resolvedThreads: 2, unreadReplies: 0, newCommits: 0, uncommittedFiles: 0,
    readingOrder: null, agent: null,
    lastActivityAt: d(2), createdAt: d(2), bucket: 'done',
  },
  {
    id: 'v10', repoId: 'r2', branch: 'feat/audit-log-export', prNumber: 402,
    title: 'CSV export for the audit log',
    author: PEOPLE.june, baseRef: 'main', draft: false, ci: 'passing',
    filesTotal: 11, filesViewed: 11, additions: 340, deletions: 22,
    openThreads: 0, resolvedThreads: 3, unreadReplies: 0, newCommits: 0, uncommittedFiles: 0,
    readingOrder: { version: 2, steps: 4 }, agent: null,
    lastActivityAt: d(3), createdAt: d(9), bucket: 'done',
  },
];

export type ActivityKind = 'agent_reply' | 'resolved' | 'commits' | 'reading_order' | 'archived' | 'opened' | 'ci';

export interface MockActivity {
  id: string;
  at: number;
  kind: ActivityKind;
  reviewId: string;
  actor: Person;
  text: string;
}

export const ACTIVITY: MockActivity[] = [
  { id: 'a1', at: m(1), kind: 'agent_reply', reviewId: 'v5', actor: PEOPLE.claude, text: 'replied on the focus-ring thread' },
  { id: 'a2', at: m(3), kind: 'reading_order', reviewId: 'v4', actor: PEOPLE.claude, text: 'generated a reading order' },
  { id: 'a3', at: m(38), kind: 'agent_reply', reviewId: 'v1', actor: PEOPLE.claude, text: 'replied on 2 threads in limiter.ts' },
  { id: 'a4', at: h(1), kind: 'commits', reviewId: 'v2', actor: PEOPLE.you, text: 'pushed 3 commits' },
  { id: 'a5', at: h(3), kind: 'ci', reviewId: 'v3', actor: PEOPLE.theo, text: 'CI failed on unit tests' },
  { id: 'a6', at: h(3), kind: 'commits', reviewId: 'v3', actor: PEOPLE.theo, text: 'pushed 2 commits' },
  { id: 'a7', at: h(7), kind: 'resolved', reviewId: 'v6', actor: PEOPLE.you, text: 'resolved 3 threads' },
  { id: 'a8', at: d(1), kind: 'archived', reviewId: 'v8', actor: PEOPLE.you, text: 'finished the review' },
  { id: 'a9', at: d(1), kind: 'opened', reviewId: 'v7', actor: PEOPLE.you, text: 'viewed all 58 files' },
  { id: 'a10', at: d(2), kind: 'archived', reviewId: 'v9', actor: PEOPLE.you, text: 'finished the review' },
];

// --- Explore ---

export interface MockPull {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  author: Person;
  updatedAt: number;
  draft: boolean;
  ci: Ci;
  additions: number;
  deletions: number;
  comments: number;
  reviewRequested: boolean;
  /** Set when you already have a review of this head. */
  reviewId: string | null;
}

export interface MockBranch {
  name: string;
  subject: string;
  author: Person;
  committerDate: number;
  tipSha: string;
  local: boolean;
  remote: boolean;
  ahead: number;
  behind: number;
  reviewId: string | null;
}

export const PULLS: Record<string, MockPull[]> = {
  r1: [
    { number: 61, title: 'Explore screen, review archiving, and Homebase redesign', headRefName: 'feat/explore-repos-branches-prs', baseRefName: 'main', author: PEOPLE.you, updatedAt: h(1), draft: false, ci: 'pending', additions: 1906, deletions: 131, comments: 0, reviewRequested: false, reviewId: 'v2' },
    { number: 60, title: 'Command palette: theme search and review switcher', headRefName: 'feat/palette-modes', baseRefName: 'main', author: PEOPLE.claude, updatedAt: h(5), draft: true, ci: 'passing', additions: 388, deletions: 40, comments: 2, reviewRequested: true, reviewId: null },
    { number: 57, title: 'Shrink the unchanged-context expansion step to 20 lines', headRefName: 'fix/diff-context-expansion', baseRefName: 'main', author: PEOPLE.claude, updatedAt: d(2), draft: false, ci: 'passing', additions: 18, deletions: 9, comments: 4, reviewRequested: false, reviewId: 'v9' },
  ],
  r2: [
    { number: 421, title: 'Move session store behind an interface', headRefName: 'refactor/session-store', baseRefName: 'main', author: PEOPLE.june, updatedAt: m(9), draft: true, ci: 'passing', additions: 1210, deletions: 980, comments: 0, reviewRequested: false, reviewId: 'v4' },
    { number: 418, title: 'Token-bucket rate limiting for public endpoints', headRefName: 'feat/rate-limit-middleware', baseRefName: 'main', author: PEOPLE.mara, updatedAt: m(38), draft: false, ci: 'passing', additions: 612, deletions: 148, comments: 7, reviewRequested: true, reviewId: 'v1' },
    { number: 419, title: 'Retry idempotent webhooks with jittered backoff', headRefName: 'feat/webhook-retries', baseRefName: 'main', author: PEOPLE.theo, updatedAt: h(2), draft: false, ci: 'failing', additions: 240, deletions: 65, comments: 1, reviewRequested: true, reviewId: null },
    { number: 415, title: 'Regenerate clients from the OpenAPI 3.1 spec', headRefName: 'chore/openapi-3.1', baseRefName: 'main', author: PEOPLE.theo, updatedAt: d(1), draft: false, ci: 'passing', additions: 3100, deletions: 2870, comments: 2, reviewRequested: false, reviewId: 'v7' },
    { number: 402, title: 'CSV export for the audit log', headRefName: 'feat/audit-log-export', baseRefName: 'main', author: PEOPLE.june, updatedAt: d(3), draft: false, ci: 'passing', additions: 340, deletions: 22, comments: 3, reviewRequested: false, reviewId: 'v10' },
  ],
  r3: [
    { number: 92, title: 'Round invoice line totals once, at the end', headRefName: 'fix/invoice-rounding', baseRefName: 'develop', author: PEOPLE.theo, updatedAt: h(3), draft: false, ci: 'failing', additions: 74, deletions: 31, comments: 5, reviewRequested: true, reviewId: 'v3' },
    { number: 88, title: 'Dunning email sequence with per-tenant templates', headRefName: 'feat/dunning-emails', baseRefName: 'develop', author: PEOPLE.mara, updatedAt: h(7), draft: false, ci: 'passing', additions: 402, deletions: 12, comments: 7, reviewRequested: false, reviewId: 'v6' },
  ],
  r4: [
    { number: 12, title: 'Semantic spacing scale and Figma sync', headRefName: 'feat/semantic-spacing', baseRefName: 'main', author: PEOPLE.you, updatedAt: d(1), draft: false, ci: 'passing', additions: 210, deletions: 66, comments: 6, reviewRequested: false, reviewId: 'v8' },
  ],
};

export const BRANCHES: Record<string, MockBranch[]> = {
  r1: [
    { name: 'agent/threads-panel-polish', subject: 'Polish threads panel and remove a focus-ring glitch', author: PEOPLE.claude, committerDate: m(1), tipSha: '718a9a1c', local: true, remote: false, ahead: 4, behind: 0, reviewId: 'v5' },
    { name: 'agent/file-tree-keyboard', subject: 'Arrow-key navigation in the file tree', author: PEOPLE.claude, committerDate: h(4), tipSha: 'c02d91e0', local: true, remote: false, ahead: 2, behind: 1, reviewId: null },
    { name: 'spike/pierre-trees-upgrade', subject: 'Try @pierre/trees 1.0 beta 7', author: PEOPLE.you, committerDate: d(1), tipSha: '9be1f7aa', local: true, remote: false, ahead: 1, behind: 6, reviewId: null },
    { name: 'fix/worker-pool-teardown', subject: 'Terminate diff workers on window unload', author: PEOPLE.you, committerDate: d(3), tipSha: '41ac0e3d', local: true, remote: true, ahead: 0, behind: 12, reviewId: null },
    { name: 'main', subject: 'Show panel state as a filled sidebar, not a direction arrow', author: PEOPLE.you, committerDate: d(1), tipSha: '0c117d0b', local: true, remote: true, ahead: 0, behind: 0, reviewId: null },
  ],
  r2: [
    { name: 'agent/perf-n-plus-one', subject: 'Batch tenant lookups in the audit middleware', author: PEOPLE.claude, committerDate: h(1), tipSha: '7d0e4c11', local: true, remote: false, ahead: 3, behind: 0, reviewId: null },
    { name: 'june/scratch-pagination', subject: 'wip cursor pagination', author: PEOPLE.june, committerDate: h(9), tipSha: 'e12ba904', local: false, remote: true, ahead: 5, behind: 3, reviewId: null },
    { name: 'release/2026.09', subject: 'Bump version to 2026.9.0', author: PEOPLE.theo, committerDate: d(2), tipSha: '55fe0c72', local: false, remote: true, ahead: 0, behind: 0, reviewId: null },
    { name: 'main', subject: 'Merge pull request #417 from northwind/fix-cors', author: PEOPLE.mara, committerDate: h(6), tipSha: 'a9c3b2d1', local: true, remote: true, ahead: 0, behind: 0, reviewId: null },
  ],
  r3: [
    { name: 'agent/stripe-webhook-idempotency', subject: 'Dedupe Stripe events by id before processing', author: PEOPLE.claude, committerDate: h(2), tipSha: '3f8a1b09', local: true, remote: false, ahead: 2, behind: 0, reviewId: null },
    { name: 'develop', subject: 'Merge pull request #90 from northwind/tax-rates', author: PEOPLE.theo, committerDate: h(5), tipSha: 'b77e2d40', local: true, remote: true, ahead: 0, behind: 0, reviewId: null },
    { name: 'hotfix/currency-fallback', subject: 'Fall back to USD when tenant currency is unset', author: PEOPLE.mara, committerDate: d(4), tipSha: '0d9c4e1f', local: false, remote: true, ahead: 1, behind: 20, reviewId: null },
  ],
  r4: [
    { name: 'main', subject: 'Publish 1.4.0', author: PEOPLE.you, committerDate: d(2), tipSha: '6c1d0a22', local: true, remote: true, ahead: 0, behind: 0, reviewId: null },
    { name: 'feat/motion-tokens', subject: 'Easing and duration tokens', author: PEOPLE.you, committerDate: d(8), tipSha: '1e9f7b3c', local: true, remote: false, ahead: 3, behind: 4, reviewId: null },
  ],
};

// Extra unreviewed PRs so the queue has something to show.
PULLS['r1']?.push(
  { number: 59, title: 'Sticky file headers while scrolling a long diff', headRefName: 'feat/sticky-file-headers', baseRefName: 'main', author: PEOPLE.claude, updatedAt: h(8), draft: false, ci: 'passing', additions: 142, deletions: 37, comments: 0, reviewRequested: true, reviewId: null },
);
PULLS['r2']?.push(
  { number: 420, title: 'Tenant-scoped feature flags with a 30s cache', headRefName: 'feat/tenant-flags', baseRefName: 'main', author: PEOPLE.mara, updatedAt: h(4), draft: false, ci: 'passing', additions: 860, deletions: 212, comments: 3, reviewRequested: true, reviewId: null },
  { number: 416, title: 'Fix typo in README', headRefName: 'docs/readme-typo', baseRefName: 'main', author: PEOPLE.june, updatedAt: d(1), draft: false, ci: 'passing', additions: 1, deletions: 1, comments: 0, reviewRequested: false, reviewId: null },
);
PULLS['r3']?.push(
  { number: 93, title: 'Migrate ledger to bigint amounts', headRefName: 'feat/bigint-ledger', baseRefName: 'develop', author: PEOPLE.theo, updatedAt: h(6), draft: true, ci: 'pending', additions: 2410, deletions: 1980, comments: 1, reviewRequested: false, reviewId: null },
);
PULLS['r4']?.push(
  { number: 13, title: 'Dark-mode elevation tokens', headRefName: 'feat/elevation-dark', baseRefName: 'main', author: PEOPLE.you, updatedAt: d(3), draft: false, ci: 'passing', additions: 58, deletions: 12, comments: 0, reviewRequested: false, reviewId: null },
);

// --- effort score ---
//
// Placeholder heuristic until we define the real thing: files carry more
// weight than lines (a 40-file rename is harder to hold in your head than
// one 400-line file), and the whole thing is bucketed into four levels.

export type EffortLevel = 1 | 2 | 3 | 4;

export interface Effort {
  level: EffortLevel;
  label: string;
  /** Rough minutes, rounded to 5. */
  minutes: number;
  /** Raw score, for ordering. */
  score: number;
}

export function effortOf(x: { filesTotal?: number; additions: number; deletions: number }, files = x.filesTotal): Effort {
  const lines = x.additions + x.deletions;
  const fileCount = files ?? Math.max(1, Math.round(lines / 60));
  const score = fileCount * 1.5 + lines / 60;
  const level: EffortLevel = score < 15 ? 1 : score < 40 ? 2 : score < 90 ? 3 : 4;
  const label = ['Light', 'Moderate', 'Heavy', 'Marathon'][level - 1] ?? 'Light';
  const minutes = Math.max(5, Math.round((score * 1.6) / 5) * 5);
  return { level, label, minutes, score };
}
