/**
 * Homebase (SPEC §1): one row per branch across registered repos. This is a
 * thin list view — the lazy-computed row data (§1) is entirely server-side;
 * the web app only renders what `GET /api/reviews` (+ `/api/repos`) returns
 * and degrades to a clear empty/error state when the server is unreachable.
 */
import { GitBranch, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { goReview } from '../lib/router.ts';
import type { Repo, Review } from '@review/core';

export function Homebase(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [repoRes, reviewRes] = await Promise.all([
        callApi('listRepos'),
        callApi('listReviews'),
      ]);
      setRepos(repoRes.repos);
      setReviews(reviewRes.reviews);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Can't reach the review server: ${err.message}`
          : 'Unknown error loading Homebase',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const repoById = new Map(repos.map((r) => [r.id, r]));

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-[15px] font-medium text-chrome-fg">Homebase</h1>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh"
          className="flex items-center gap-1.5 rounded-md border border-chrome-border px-2.5 py-1.5 text-xs text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised"
        >
          <RefreshCw size={16} strokeWidth={1.5} aria-hidden />
          Refresh
        </button>
      </header>

      {error !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-chrome-danger bg-chrome-danger-bg p-3 text-sm text-chrome-fg"
        >
          <span className="font-medium">{error}</span>
          <span className="text-chrome-fg-muted">
            Start the server (`bun run --filter '@review/server' dev`) and refresh.
          </span>
        </div>
      )}

      {!loading && error === null && reviews.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-chrome-border p-10 text-center text-sm text-chrome-fg-muted">
          <GitBranch size={20} strokeWidth={1.5} aria-hidden />
          <p>No reviews yet. Register a repo and create a review from the CLI.</p>
          <code className="rounded bg-chrome-bg-sunken px-2 py-1 text-xs">
            review repos add . &amp;&amp; review create --branch &lt;name&gt;
          </code>
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {reviews.map((review) => {
          const repo = repoById.get(review.repoId);
          return (
            <li key={review.id}>
              <button
                type="button"
                onClick={() => goReview(review.id)}
                className="flex w-full items-center justify-between gap-3 rounded-md border border-chrome-border bg-chrome-bg-raised px-3 py-2.5 text-left transition-colors hover:border-chrome-border-strong"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch size={16} strokeWidth={1.5} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
                  <span className="truncate text-sm text-chrome-fg">
                    {review.branch ?? review.pinnedSha?.slice(0, 10) ?? 'detached'}
                  </span>
                  <span className="truncate text-xs text-chrome-fg-subtle">
                    {repo?.rootPath ?? review.repoId}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-chrome-fg-muted">
                  {review.prNumber !== null && <span>PR #{review.prNumber}</span>}
                  <StatusPill status={review.status} />
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusPill({ status }: { status: Review['status'] }): React.JSX.Element {
  const styles: Record<Review['status'], string> = {
    open: 'text-chrome-success',
    orphaned: 'text-chrome-warning',
    archived: 'text-chrome-fg-subtle',
  };
  return <span className={styles[status]}>{status}</span>;
}
