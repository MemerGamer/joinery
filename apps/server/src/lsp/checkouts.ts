/**
 * Checkouts for language servers, for reviews whose branch isn't checked out
 * anywhere. A server reads the project from disk, so it needs the review's
 * commit on disk; these are detached worktrees of ours under
 * `data/worktrees/lsp/<repo>/`, moved from commit to commit rather than made
 * per commit:
 *
 * - One per commit being shown: reviews on the same commit share it.
 * - At most `MAX_PER_REPO` per repo. Past that, the least recently used one
 *   is taken over, and its review gets one back on its next hover.
 * - A review that goes away frees its checkout; one free checkout per repo
 *   is kept for the next review, since moving one only rewrites the files
 *   that differ, and the rest are removed.
 * - The main clone's ignored `node_modules`/`vendor` directories are linked
 *   in, so dependencies resolve without installing them again. They are
 *   unlinked before every move, so git never writes through them.
 *
 * Before a checkout moves or goes, `onVacate` stops the servers running in
 * it. Operations are serialized per repo.
 */
import { lstat, mkdir, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { removeOwnWorktree } from '../agent/maintenance.ts';
import { resolveDataPaths } from '../db/paths.ts';
import { checkoutDetached, createDetachedWorktree, git } from '../git/index.ts';

const MAX_PER_REPO = 3;
const DEPENDENCY_DIRS = new Set(['node_modules', 'vendor']);

type Checkout = {
  readonly path: string;
  /** Empty when a move failed half-way: the next use moves it again. */
  sha: string;
  readonly reviews: Set<string>;
  lastUsed: number;
};

type Pool = {
  readonly repoId: string;
  repoRoot: string;
  /** Null until the checkouts left by a previous run are adopted. */
  checkouts: Checkout[] | null;
  /** Repo-relative dependency directories of the main clone, to link in. */
  dependencies: string[] | null;
  queue: Promise<unknown>;
};

export type CheckoutRequest = {
  readonly reviewId: string;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly sha: string;
};

function poolDir(repoId: string): string {
  return join(resolveDataPaths().worktreesDir, 'lsp', repoId);
}

export class CheckoutPool {
  readonly #pools = new Map<string, Pool>();
  readonly #onVacate: (path: string) => Promise<void>;

  constructor(onVacate: (path: string) => Promise<void>) {
    this.#onVacate = onVacate;
  }

  /** A checkout at `sha` for this review: its own, a shared one, a free one moved there, or a new one. */
  acquire(request: CheckoutRequest): Promise<string> {
    const pool = this.#pool(request.repoId, request.repoRoot);
    return this.#serial(pool, () => this.#acquire(pool, request));
  }

  /** The review no longer needs a checkout; spare ones beyond the one kept are removed. */
  async release(reviewId: string): Promise<void> {
    await Promise.all(
      Array.from(this.#pools.values(), (pool) =>
        this.#serial(pool, async () => {
          if (pool.checkouts === null) return;
          for (const checkout of pool.checkouts) checkout.reviews.delete(reviewId);
          await this.#trim(pool);
        }),
      ),
    );
  }

  /** Every checkout of `repoId` removed (the repo is being removed from Joinery). */
  async removeRepo(repoId: string, repoRoot: string): Promise<void> {
    const pool = this.#pool(repoId, repoRoot);
    await this.#serial(pool, async () => {
      for (const checkout of await this.#load(pool)) await this.#remove(pool, checkout);
      await rm(poolDir(repoId), { recursive: true, force: true });
    });
    this.#pools.delete(repoId);
  }

  /** Every checkout removed, including ones a previous run left; returns how many. Later hovers make new ones. */
  async clear(): Promise<number> {
    let removed = 0;
    await Promise.all(
      Array.from(this.#pools.values(), (pool) =>
        this.#serial(pool, async () => {
          for (const checkout of await this.#load(pool)) {
            await this.#remove(pool, checkout);
            removed += 1;
          }
        }),
      ),
    );
    // Repos not hovered since the server started: nothing runs in their checkouts.
    const root = join(resolveDataPaths().worktreesDir, 'lsp');
    for (const repoId of await readdir(root).catch(() => [] as string[])) {
      if (this.#pools.has(repoId)) continue;
      for (const name of await readdir(join(root, repoId)).catch(() => [] as string[])) {
        await removeOwnWorktree(join(root, repoId, name), null);
        removed += 1;
      }
      await rm(join(root, repoId), { recursive: true, force: true });
    }
    return removed;
  }

  #pool(repoId: string, repoRoot: string): Pool {
    let pool = this.#pools.get(repoId);
    if (pool === undefined) {
      pool = { repoId, repoRoot, checkouts: null, dependencies: null, queue: Promise.resolve() };
      this.#pools.set(repoId, pool);
    }
    pool.repoRoot = repoRoot;
    return pool;
  }

  #serial<T>(pool: Pool, task: () => Promise<T>): Promise<T> {
    const run = pool.queue.then(task, task);
    pool.queue = run.catch(() => undefined);
    return run;
  }

  async #acquire(pool: Pool, request: CheckoutRequest): Promise<string> {
    const checkouts = await this.#load(pool);
    const now = Date.now();
    const own = checkouts.find((c) => c.reviews.has(request.reviewId));
    if (own !== undefined && own.sha === request.sha) {
      own.lastUsed = now;
      return own.path;
    }
    own?.reviews.delete(request.reviewId);

    let target = checkouts.find((c) => c.sha === request.sha);
    if (target === undefined) {
      const free = checkouts.filter((c) => c.reviews.size === 0).sort((a, b) => b.lastUsed - a.lastUsed);
      // The review's own checkout first, so a revision switch moves it rather than another review's.
      target = own !== undefined && own.reviews.size === 0 ? own : free[0];
      if (target === undefined && checkouts.length < MAX_PER_REPO) {
        target = await this.#create(pool, request.sha);
      } else if (target === undefined) {
        target = checkouts.toSorted((a, b) => a.lastUsed - b.lastUsed)[0];
        if (target === undefined) throw new Error('no checkout to take over');
        target.reviews.clear();
      }
      if (target.sha !== request.sha) await this.#move(pool, target, request.sha);
    }
    target.reviews.add(request.reviewId);
    target.lastUsed = now;
    return target.path;
  }

  /** The checkouts on disk, adopting what a previous run left behind (free, at whatever commit they're on). */
  async #load(pool: Pool): Promise<Checkout[]> {
    if (pool.checkouts !== null) return pool.checkouts;
    const checkouts: Checkout[] = [];
    const names = await readdir(poolDir(pool.repoId)).catch(() => [] as string[]);
    for (const name of names) {
      const path = join(poolDir(pool.repoId), name);
      // Only a worktree's own `.git` file counts: without it git would answer
      // for whatever repo the data dir happens to sit in.
      const isWorktree = (await lstat(join(path, '.git')).catch(() => null))?.isFile() === true;
      const head = isWorktree ? await git(['rev-parse', 'HEAD'], { cwd: path }) : null;
      if (head !== null && head.exitCode === 0) {
        checkouts.push({ path, sha: new TextDecoder().decode(head.stdout).trim(), reviews: new Set(), lastUsed: 0 });
      } else {
        await removeOwnWorktree(path, pool.repoRoot).catch(() => undefined);
        await rm(path, { recursive: true, force: true });
      }
    }
    pool.checkouts = checkouts;
    await this.#trim(pool);
    return checkouts;
  }

  async #create(pool: Pool, sha: string): Promise<Checkout> {
    const checkouts = pool.checkouts ?? [];
    const taken = new Set(checkouts.map((c) => basename(c.path)));
    let index = 1;
    while (taken.has(`checkout-${index}`)) index += 1;
    const path = join(poolDir(pool.repoId), `checkout-${index}`);
    const dataDir = resolveDataPaths().root;
    // A directory git no longer knows (killed mid-create): clear it, or `worktree add` refuses.
    await removeOwnWorktree(path, pool.repoRoot).catch(() => undefined);
    await mkdir(dirname(path), { recursive: true });
    const started = Date.now();
    await createDetachedWorktree({ repoCwd: pool.repoRoot, sha, path, dataDir });
    const checkout: Checkout = { path, sha, reviews: new Set(), lastUsed: Date.now() };
    checkouts.push(checkout);
    await this.#linkDependencies(pool, checkout);
    console.log(`[lsp] made checkout ${path} at ${sha.slice(0, 12)} in ${Date.now() - started} ms`);
    return checkout;
  }

  async #move(pool: Pool, checkout: Checkout, sha: string): Promise<void> {
    await this.#onVacate(checkout.path);
    await this.#unlinkDependencies(pool, checkout);
    checkout.sha = '';
    await checkoutDetached({ worktreePath: checkout.path, sha, dataDir: resolveDataPaths().root });
    checkout.sha = sha;
    await this.#linkDependencies(pool, checkout);
  }

  /** Free checkouts beyond the most recently used one, removed. */
  async #trim(pool: Pool): Promise<void> {
    const free = (pool.checkouts ?? []).filter((c) => c.reviews.size === 0).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const checkout of free.slice(1)) await this.#remove(pool, checkout);
  }

  async #remove(pool: Pool, checkout: Checkout): Promise<void> {
    await this.#onVacate(checkout.path);
    await this.#unlinkDependencies(pool, checkout);
    await removeOwnWorktree(checkout.path, pool.repoRoot);
    pool.checkouts = (pool.checkouts ?? []).filter((c) => c !== checkout);
    console.log(`[lsp] removed checkout ${checkout.path}`);
  }

  /** The main clone's ignored `node_modules`/`vendor` directories, at any depth (git collapses each to one entry). */
  async #dependencies(pool: Pool): Promise<string[]> {
    if (pool.dependencies !== null) return pool.dependencies;
    const result = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
      cwd: pool.repoRoot,
    });
    pool.dependencies =
      result.exitCode !== 0
        ? []
        : new TextDecoder()
            .decode(result.stdout)
            .split('\0')
            .map((entry) => entry.replace(/\/$/u, ''))
            .filter((entry) => DEPENDENCY_DIRS.has(basename(entry)));
    return pool.dependencies;
  }

  async #linkDependencies(pool: Pool, checkout: Checkout): Promise<void> {
    for (const rel of await this.#dependencies(pool)) {
      const link = join(checkout.path, rel);
      // Only where the commit has the directory's parent and nothing of its own there.
      if ((await lstat(dirname(link)).catch(() => null))?.isDirectory() !== true) continue;
      if ((await lstat(link).catch(() => null)) !== null) continue;
      await symlink(join(pool.repoRoot, rel), link, 'dir').catch(() => undefined);
    }
  }

  async #unlinkDependencies(pool: Pool, checkout: Checkout): Promise<void> {
    for (const rel of await this.#dependencies(pool)) {
      const link = join(checkout.path, rel);
      if ((await lstat(link).catch(() => null))?.isSymbolicLink() === true) await unlink(link);
    }
  }
}
