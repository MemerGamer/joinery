/**
 * Seeds a fake, self-contained Joinery demo (README screenshots, demo video).
 *
 *   bun scripts/demo/seed.ts
 *
 * Wipes and rebuilds /tmp/joinery-demo (override with JOINERY_DEMO_DIR):
 *   repos/   fake git repositories (no remotes, so no gh/glab calls anywhere)
 *   data/    a separate Joinery data dir (JOINERY_DATA_DIR), never ./data
 *
 * It starts a throwaway server against that data dir, fills it through the
 * normal HTTP API (repos, reviews, reading orders, threads, agent replies),
 * backdates timestamps so the UI looks lived-in, then stops the server.
 * No network, no Claude calls.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { demoEnv, writeDemoGitConfig, REMOTE_OWNER } from './env.ts';
import { BILLING, STOREFRONT, JOHN, type Commit, type Files, type RepoFixture } from './fixtures.ts';

const ROOT = process.env['JOINERY_DEMO_DIR'] ?? '/tmp/joinery-demo';
const PORT = Number(process.env['JOINERY_DEMO_PORT'] ?? 7318);
const REPOS_DIR = join(ROOT, 'repos');
const DATA_DIR = join(ROOT, 'data');
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BASE = `http://127.0.0.1:${String(PORT)}`;

if (DATA_DIR === join(REPO_ROOT, 'data') || ROOT === '/' || ROOT === '') throw new Error('refusing to touch the real data dir');

// --- git helpers -------------------------------------------------------------

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed in ${cwd}: ${err || out}`);
  return out;
}

function writeFiles(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

async function commit(dir: string, c: Commit): Promise<void> {
  writeFiles(dir, c.files);
  await sh(['git', 'add', '-A'], dir);
  const when = new Date(Date.now() - c.hoursAgo * 3_600_000).toISOString();
  await sh(['git', 'commit', '-q', '-m', c.message], dir, {
    GIT_AUTHOR_NAME: c.author.name,
    GIT_AUTHOR_EMAIL: c.author.email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: c.author.name,
    GIT_COMMITTER_EMAIL: c.author.email,
    GIT_COMMITTER_DATE: when,
  });
}

async function buildRepo(fx: RepoFixture): Promise<string> {
  const dir = join(REPOS_DIR, fx.dir);
  mkdirSync(dir, { recursive: true });
  await sh(['git', 'init', '-q', '-b', 'main'], dir);
  // The reviewer ("me") in the UI greeting.
  for (const c of fx.main) await commit(dir, c);
  for (const b of fx.branches) {
    await sh(['git', 'checkout', '-q', '-b', b.name, 'main'], dir);
    for (const c of b.commits) await commit(dir, c);
    await sh(['git', 'checkout', '-q', 'main'], dir);
  }
  for (const b of fx.branches) {
    if (b.worktree === undefined) continue;
    const wt = join(REPOS_DIR, b.worktree.dir);
    await sh(['git', 'worktree', 'add', '-q', wt, b.name], dir);
    writeFiles(wt, b.worktree.dirty); // uncommitted work
  }
  // A fake github.com origin, served from a local bare clone via the demo gitconfig's insteadOf.
  const env = demoEnv(ROOT);
  const remote = join(ROOT, 'remotes', `${fx.dir}.git`);
  await sh(['git', 'clone', '-q', '--bare', dir, remote], ROOT, env);
  await sh(['git', 'remote', 'add', 'origin', `https://github.com/${REMOTE_OWNER}/${fx.dir}.git`], dir, env);
  await sh(['git', 'fetch', '-q', 'origin'], dir, env);
  return dir;
}

/** 1-based line of the first line containing `needle` in `path` at `branch`. */
async function lineOf(repoDir: string, branch: string, path: string, needle: string): Promise<number> {
  const text = await sh(['git', 'show', `${branch}:${path}`], repoDir);
  const idx = text.split('\n').findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`"${needle}" not found in ${branch}:${path}`);
  return idx + 1;
}

// --- server + API ------------------------------------------------------------

let token = '';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${String(res.status)} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function startServer(): Promise<ReturnType<typeof Bun.spawn>> {
  const log = Bun.file(join(ROOT, 'server.log'));
  const proc = Bun.spawn(['bun', 'apps/server/src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...demoEnv(ROOT), JOINERY_DATA_DIR: DATA_DIR, JOINERY_PORT: String(PORT) },
    stdout: log,
    stderr: log,
  });
  const tokenFile = join(DATA_DIR, 'token');
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(150);
    if (!existsSync(tokenFile)) continue;
    token = readFileSync(tokenFile, 'utf8').trim();
    try {
      const res = await fetch(`${BASE}/api/repos`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return proc;
    } catch {
      // not listening yet
    }
  }
  proc.kill();
  throw new Error(`server did not come up; see ${join(ROOT, 'server.log')}`);
}

// --- seeding -----------------------------------------------------------------

type Repo = { id: string };
type Review = { id: string };
type Thread = { id: string; comments: { id: string }[] };

async function openReview(repo: Repo, branch: string, status: 'open' | 'draft' = 'open'): Promise<string> {
  const res = await api<{ review: Review }>('POST', '/api/reviews', { repoId: repo.id, branch, status });
  return res.review.id;
}

async function filePaths(reviewId: string): Promise<string[]> {
  const res = await api<{ list: { files: { path: string }[] } }>('GET', `/api/reviews/${reviewId}/files`);
  return res.list.files.map((f) => f.path);
}

type Step = { title: string; guidance: string; attention: 'focus' | 'skim' | null; files: { path: string; note: string | null }[] };

async function setReadingOrder(reviewId: string, steps: Step[]): Promise<void> {
  const known = new Set(await filePaths(reviewId));
  for (const s of steps) for (const f of s.files) if (!known.has(f.path)) throw new Error(`reading order file not in diff: ${f.path}`);
  await api('PUT', `/api/reviews/${reviewId}/reading-order`, { steps });
}

/** A user comment with an optional chain of replies ('agent' | 'user'), optionally resolved. */
async function thread(
  reviewId: string,
  anchor: { path: string; line: number; endLine?: number },
  messages: { by: 'user' | 'agent'; body: string }[],
  options: { resolved?: boolean; reactToLast?: 'thumbs_up' | 'eyes' | 'check' } = {},
): Promise<void> {
  const [first, ...rest] = messages;
  if (first === undefined) return;
  const created = await api<{ thread: Thread }>('POST', `/api/reviews/${reviewId}/threads`, {
    path: anchor.path,
    side: 'new',
    startLine: anchor.line,
    endLine: anchor.endLine ?? anchor.line,
    body: first.body,
    author: first.by,
  });
  let last = created.thread;
  for (const m of rest) {
    const res = await api<{ thread: Thread }>('POST', `/api/threads/${created.thread.id}/replies`, { body: m.body, author: m.by });
    last = res.thread;
  }
  const lastComment = last.comments[last.comments.length - 1];
  if (options.reactToLast !== undefined && lastComment !== undefined) {
    await api('POST', `/api/comments/${lastComment.id}/reactions`, { kind: options.reactToLast, actor: 'user' });
  }
  if (options.resolved === true) await api('POST', `/api/threads/${created.thread.id}/resolve`, { resolved: true });
}

async function markViewed(reviewId: string, paths: string[]): Promise<void> {
  for (const path of paths) await api('POST', `/api/reviews/${reviewId}/viewed`, { path, viewed: true });
}

async function seedBilling(repo: Repo, dir: string): Promise<void> {
  // 1. The big one: proration, with a reading order and a lively conversation.
  const B1 = 'feat/prorate-plan-changes';
  const r1 = await openReview(repo, B1);
  await setReadingOrder(r1, [
    {
      title: 'Money gets a new home',
      guidance: '`lib/money` is renamed to `lib/currency` (plus Intl formatting) and a new `allocate()` helper appears. The rename is mechanical; `allocate` is the part worth a careful read.',
      attention: 'skim',
      files: [
        { path: 'src/lib/allocate.ts', note: '`allocate` distributes remainder cents so the parts always sum back to the whole.' },
        { path: 'src/lib/currency.ts', note: 'Renamed from `lib/money.ts`; `formatMoney` now uses `Intl.NumberFormat`.' },
        { path: 'src/invoices/types.ts', note: null },
        { path: 'src/payments/gateway.ts', note: null },
        { path: 'src/payments/stripeGateway.ts', note: null },
      ],
    },
    {
      title: 'Proration math',
      guidance: 'Check how the unused fraction is derived (`Math.ceil` of days left) and that credit and charge are rounded the same way.',
      attention: 'focus',
      files: [{ path: 'src/billing/proration.ts', note: 'New. Whole-day proration, clamped to the billing period.' }],
    },
    {
      title: 'Wiring it into changePlan',
      guidance: 'Plan changes now take effect immediately and produce an invoice with a credit line and a charge line. Look at what happens when the net total is zero or negative.',
      attention: 'focus',
      files: [{ path: 'src/invoices/service.ts', note: null }],
    },
    {
      title: 'HTTP entry point',
      guidance: 'One new route, `POST /subscriptions/:id/plan`. Thin, but it is the first route that mutates a subscription.',
      attention: null,
      files: [{ path: 'src/http/routes.ts', note: null }],
    },
    {
      title: 'Tests',
      guidance: 'Proration cases are covered at the midpoint and past the period end; `invoices.test.ts` only follows the rename.',
      attention: 'skim',
      files: [
        { path: 'test/proration.test.ts', note: null },
        { path: 'test/invoices.test.ts', note: null },
      ],
    },
  ]);
  await thread(
    r1,
    { path: 'src/billing/proration.ts', line: await lineOf(dir, B1, 'src/billing/proration.ts', 'const unused = Math.round') },
    [
      { by: 'user', body: 'Credit and charge are rounded independently here. Could that leave us a cent off from what Stripe computes for the same period?' },
      {
        by: 'agent',
        body:
          'Yes, it can. `Math.round` runs on each side separately, so for a 30-day period with 17 days left, a $29.99 plan credits `1699` while the new plan\'s charge rounds the other way, and the invoice total is one cent different from Stripe\'s proration preview.\n\nSince `allocate()` already exists in `lib/allocate.ts`, the safer shape is to compute the net once and split it across the two lines:\n\n```ts\nconst net = money(upcoming - unused, to.monthlyPrice.currency);\n```\n\nThat keeps the invoice total exactly equal to the difference of the two plans.',
      },
    ],
    { reactToLast: 'thumbs_up' },
  );
  await thread(
    r1,
    { path: 'src/billing/proration.ts', line: await lineOf(dir, B1, 'src/billing/proration.ts', 'const daysLeft') },
    [
      { by: 'user', body: 'Why `ceil`? Someone switching at 23:00 on day 10 gets billed as if day 10 were still ahead of them.' },
      {
        by: 'agent',
        body:
          'It is deliberate in the sense that a partial day always counts as a full remaining day, which favours the customer on the credit side and the business on the charge side, so they roughly cancel for upgrades. For downgrades it tilts toward the business. `test/proration.test.ts` only covers midnight boundaries, so that case is untested either way.',
      },
      { by: 'user', body: 'OK, then I would rather round to the nearest day on both sides. Can you sketch what that changes?' },
      {
        by: 'agent',
        body: 'Swapping `Math.ceil` for `Math.round` makes the 23:00 example bill 10 days instead of 11, and keeps midnight-aligned periods identical. Only the final-day edge moves: at 12:00 on the last day, `round` gives 1 day left where `ceil` also gives 1, so no regression there.',
      },
    ],
  );
  await thread(
    r1,
    { path: 'src/lib/allocate.ts', line: await lineOf(dir, B1, 'src/lib/allocate.ts', 'const step = remainder') },
    [
      { by: 'user', body: 'Does this loop always terminate when `amountMinor` is negative (credits)?' },
      {
        by: 'agent',
        body:
          'Yes. `Math.trunc` rounds toward zero, so for a negative amount `remainder` is negative and `step` is `-1`; each iteration moves `remainder` one unit closer to zero, and the loop exits when it hits `0`. The index wraps with `% shares.length`, so it cannot run off the array. The only throwing case is `ratios` summing to zero, which is guarded above.',
      },
    ],
    { resolved: true },
  );
  await thread(
    r1,
    { path: 'src/http/routes.ts', line: await lineOf(dir, B1, 'src/http/routes.ts', "app.post('/subscriptions/:id/plan'") },
    [{ by: 'user', body: 'Nothing here checks that the caller owns this subscription. Do we rely on the gateway in front of us for that?' }],
  );
  await thread(
    r1,
    { path: 'src/invoices/service.ts', line: await lineOf(dir, B1, 'src/invoices/service.ts', 'return invoice.total.amountMinor > 0') },
    [
      { by: 'user', body: 'A downgrade ends up with a negative total and we never refund or carry the credit. Is that intended for this PR?' },
    ],
  );
  await markViewed(r1, ['src/lib/currency.ts', 'src/invoices/types.ts', 'src/payments/gateway.ts']);

  // 2. Security fix: smaller, reading order, one open thread, one resolved.
  const B2 = 'fix/webhook-signature-replay';
  const r2 = await openReview(repo, B2);
  await setReadingOrder(r2, [
    {
      title: 'Signature check and replay window',
      guidance: 'The old check compared hex strings with `!==` and ignored `t`. Verify the tolerance is applied before the HMAC, and that the compare is on equal-length buffers.',
      attention: 'focus',
      files: [{ path: 'src/payments/webhook.ts', note: null }],
    },
    {
      title: 'Error handling at the route',
      guidance: 'Rejected webhooks now answer 400, which Stripe will not retry forever.',
      attention: null,
      files: [{ path: 'src/http/routes.ts', note: null }],
    },
  ]);
  await thread(
    r2,
    { path: 'src/payments/webhook.ts', line: await lineOf(dir, B2, 'src/payments/webhook.ts', 'Math.abs(nowSeconds') },
    [
      { by: 'user', body: 'The tolerance alone does not stop a replay inside the 5 minute window. Should we also remember event ids?' },
      {
        by: 'agent',
        body: 'Right, tolerance only bounds the attack window. Stripe event ids are unique, so a small TTL cache (or a unique index on `event.id` in the table the handler writes to) would close it fully. The handler in `routes.ts` currently only echoes the id, so there is no natural place to dedupe yet.',
      },
    ],
  );
  await thread(
    r2,
    { path: 'src/http/routes.ts', line: await lineOf(dir, B2, 'src/http/routes.ts', 'error instanceof Error') },
    [
      { by: 'agent', body: 'This returns `error.message` to the caller. The messages are fixed strings from `verifyWebhook`, but a future `JSON.parse` failure would echo parser internals. Consider a generic body.' },
      { by: 'user', body: 'Good point, I will map known errors to a generic message in a follow-up.' },
    ],
    { resolved: true },
  );
  await markViewed(r2, ['src/http/routes.ts']);

  // 3. A refactor with nothing reviewed yet, and 4. a draft with local edits.
  await openReview(repo, 'refactor/retry-with-backoff');
  await openReview(repo, 'feat/dunning-emails', 'draft');
}

async function seedStorefront(repo: Repo, dir: string): Promise<void> {
  const B = 'feat/cart-drawer';
  const r = await openReview(repo, B);
  await setReadingOrder(r, [
    {
      title: 'Cart store additions',
      guidance: '`removeItem` and `cartTotalCents` are the only new state logic.',
      attention: null,
      files: [{ path: 'src/cart/store.ts', note: null }],
    },
    {
      title: 'Drawer and header wiring',
      guidance: 'The drawer is a plain dialog with no focus trap yet; check the accessibility of the open/close path.',
      attention: 'focus',
      files: [
        { path: 'src/components/CartDrawer.tsx', note: 'New component.' },
        { path: 'src/components/Header.tsx', note: 'Owns the open state.' },
      ],
    },
  ]);
  await thread(
    r,
    { path: 'src/components/CartDrawer.tsx', line: await lineOf(dir, B, 'src/components/CartDrawer.tsx', 'role="dialog"') },
    [
      { by: 'user', body: 'No focus trap and no Escape handler. Keyboard users can tab straight out of the drawer into the page behind it.' },
      {
        by: 'agent',
        body: 'Confirmed: nothing moves focus into the drawer on open or returns it to the "Open cart" button on close. The native `<dialog>` element with `showModal()` gives you the trap, Escape handling and inert background for free, and would replace the `role="dialog"` attribute here.',
      },
    ],
  );
}

/** Spread comment/thread/review timestamps over the last day so "x ago" labels vary. */
function backdate(): void {
  const db = new Database(join(DATA_DIR, 'state.sqlite'));
  const now = Math.floor(Date.now() / 1000);
  const comments = db.query<{ id: string; thread_id: string }, []>('SELECT id, thread_id FROM comment ORDER BY rowid').all();
  const firstOfThread = new Map<string, number>();
  comments.forEach((c, i) => {
    const at = now - (comments.length - i) * 3 * 60;
    if (!firstOfThread.has(c.thread_id)) firstOfThread.set(c.thread_id, at);
    db.run('UPDATE comment SET created_at = ? WHERE id = ?', [at, c.id]);
  });
  for (const [id, at] of firstOfThread) db.run('UPDATE thread SET created_at = ? WHERE id = ?', [at, id]);
  const reviews = db.query<{ id: string }, []>('SELECT id FROM review ORDER BY rowid').all();
  reviews.forEach((r, i) => db.run('UPDATE review SET created_at = ?, last_opened_at = NULL WHERE id = ?', [now - (reviews.length - i) * 5 * 3600, r.id]));
  // The webhook review was opened after its last reply; the proration one has unread agent replies.
  db.run(
    "UPDATE review SET last_opened_at = ? WHERE branch IN ('fix/webhook-signature-replay', 'feat/cart-drawer')",
    [now],
  );
  db.close();
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(REPOS_DIR, { recursive: true });
  writeDemoGitConfig(ROOT, [BILLING.dir, STOREFRONT.dir]);

  console.log('building fake repos...');
  const billingDir = await buildRepo(BILLING);
  const storeDir = await buildRepo(STOREFRONT);

  console.log(`starting a throwaway server on :${String(PORT)} (data dir ${DATA_DIR})...`);
  const server = await startServer();
  try {
    const billing = (await api<{ repo: Repo }>('POST', '/api/repos', { path: billingDir })).repo;
    const store = (await api<{ repo: Repo }>('POST', '/api/repos', { path: storeDir })).repo;
    await seedBilling(billing, billingDir);
    await seedStorefront(store, storeDir);
  } finally {
    server.kill('SIGTERM');
    await server.exited;
  }
  backdate();
  console.log('done. Start the demo with:\n  JOINERY_DATA_DIR=' + DATA_DIR + ' JOINERY_PORT=' + String(PORT) + ' bun apps/server/src/index.ts');
}

await main();
