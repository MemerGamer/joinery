/**
 * Which directory a review's language servers run in, kept ready while a
 * window shows the review.
 *
 * - The review's branch is checked out (the main clone or a worktree of the
 *   user's): there, as the user sees it.
 * - Otherwise: a checkout of the review's current commit (`checkouts.ts`).
 *   Switching revision or a new push moves it along.
 *
 * Opening a review prepares that directory and starts the servers for the
 * languages its diff touches, a moment after its file list is sent, so the
 * first hover doesn't wait. Closing the last window on it frees its checkout
 * after `CLOSE_GRACE_MS`, so a reload keeps it.
 */
import type { FileList, Repo, Revision } from '@joinery/core';
import { CheckoutPool } from './checkouts.ts';
import { languageOf, lsp } from './index.ts';

const CLOSE_GRACE_MS = 60_000;
const PREPARE_DELAY_MS = 1_000;

/** What views need from a review's engine (`ReviewEngine`). */
export type ViewedReview = {
  readonly reviewId: string;
  readonly repo: Repo;
  getRenderContext(): { attachedPath: string | null; revision: Revision; headSha: string };
  getFileList(): FileList;
};

class LspViews {
  readonly #checkouts = new CheckoutPool((path) => lsp.stopRoot(path));
  /** Open windows per review. */
  readonly #open = new Map<string, number>();
  readonly #closing = new Map<string, ReturnType<typeof setTimeout>>();

  opened(review: ViewedReview): void {
    const { reviewId } = review;
    this.#open.set(reviewId, (this.#open.get(reviewId) ?? 0) + 1);
    clearTimeout(this.#closing.get(reviewId));
    this.#closing.delete(reviewId);
    setTimeout(() => this.changed(review), PREPARE_DELAY_MS).unref?.();
  }

  /** The review moved (a tick, a revision switch): follow it, if a window still shows it. */
  changed(review: ViewedReview): void {
    if (!this.#open.has(review.reviewId)) return;
    this.#prepare(review).catch((err: unknown) =>
      console.log(`[lsp] could not prepare ${review.reviewId}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  closed(reviewId: string): void {
    const count = (this.#open.get(reviewId) ?? 0) - 1;
    if (count > 0) {
      this.#open.set(reviewId, count);
      return;
    }
    this.#open.delete(reviewId);
    const timer = setTimeout(() => {
      this.#closing.delete(reviewId);
      void this.#checkouts.release(reviewId);
    }, CLOSE_GRACE_MS);
    timer.unref?.();
    this.#closing.set(reviewId, timer);
  }

  /**
   * The directory to run `review`'s servers in. Falls back to the main clone
   * when a checkout can't be made (the commit isn't fetched yet, a git error):
   * hover then still answers for the hovered file.
   */
  async rootFor(review: ViewedReview): Promise<string> {
    const ctx = review.getRenderContext();
    if (ctx.attachedPath !== null) return ctx.attachedPath;
    if (ctx.headSha === '') return review.repo.rootPath;
    try {
      return await this.#checkouts.acquire({
        reviewId: review.reviewId,
        repoId: review.repo.id,
        repoRoot: review.repo.rootPath,
        sha: ctx.headSha,
      });
    } catch (err) {
      console.log(`[lsp] no checkout for ${review.reviewId}: ${err instanceof Error ? err.message : String(err)}`);
      return review.repo.rootPath;
    }
  }

  removeRepo(repo: Repo): Promise<void> {
    return this.#checkouts.removeRepo(repo.id, repo.rootPath);
  }

  clearCheckouts(): Promise<number> {
    return this.#checkouts.clear();
  }

  async #prepare(review: ViewedReview): Promise<void> {
    const root = await this.rootFor(review);
    // Closed while the checkout was being made: give it straight back.
    if (!this.#open.has(review.reviewId) && !this.#closing.has(review.reviewId)) {
      await this.#checkouts.release(review.reviewId);
      return;
    }
    const languages = review
      .getFileList()
      .files.filter((f) => f.status !== 'deleted' && !f.binary)
      .flatMap((f) => languageOf(f.path)?.language ?? []);
    await lsp.warm(root, languages);
  }
}

export const lspViews = new LspViews();
