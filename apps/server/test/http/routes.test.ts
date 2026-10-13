/**
 * Behavioural tests for routes.ts, against a real temp git repo + temp
 * sqlite db, driven through `app.fetch`.
 */
import { describe, expect, test } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { apiFetch, setupHttp, setupHttpWithReview } from './helpers.ts';
import type { Repo, Review, ReviewState } from '@joinery/core';

type ErrorBody = { error: { code: string; message: string; hint?: string } };

describe('routes.ts: repos', () => {
  test('POST /api/repos rejects a relative path with a clear 400 (regression: relative paths must never resolve against the server cwd)', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: 'relative/path' } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
      expect(json.error.message).toContain('absolute');
      expect(json.error.hint).toBeDefined();
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/repos registers a repo given its absolute path', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: fixture.repoDir } });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { repo: Repo };
      // Routes canonicalize via realpath (macOS resolves /tmp -> /private/tmp),
      // so compare against the canonical form rather than the raw temp path.
      expect(json.repo.rootPath).toBe(await realpath(fixture.repoDir));
      expect(json.repo.defaultBranch).toBe('main');
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/repos rejects a path that does not exist', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: '/definitely/not/a/real/path/xyz' } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/repos rejects an absolute path that is not a git repo', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: fixture.dataDir } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('bad_request');
      expect(json.error.message).toContain('not a git repository');
    } finally {
      await fixture.cleanup();
    }
  });

  test('GET /api/repos lists registered repos', async () => {
    const fixture = await setupHttp();
    try {
      await apiFetch(fixture, 'POST', '/api/repos', { body: { path: fixture.repoDir } });
      const res = await apiFetch(fixture, 'GET', '/api/repos');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { repos: Repo[] };
      expect(json.repos).toHaveLength(1);
      expect(json.repos[0]?.rootPath).toBe(await realpath(fixture.repoDir));
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('routes.ts: reviews', () => {
  test('POST /api/reviews creates a review for a branch and returns review/repo/state', async () => {
    const fixture = await setupHttp('feature');
    try {
      const repoRes = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: fixture.repoDir } });
      const { repo } = (await repoRes.json()) as { repo: Repo };

      const res = await apiFetch(fixture, 'POST', '/api/reviews', { body: { repoId: repo.id, branch: 'feature' } });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { review: Review; repo: Repo; state: ReviewState };
      expect(json.review.branch).toBe('feature');
      expect(json.review.repoId).toBe(repo.id);
      expect(json.state.reviewId).toBe(json.review.id);
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/reviews requires one of branch or sha', async () => {
    const fixture = await setupHttp();
    try {
      const repoRes = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: fixture.repoDir } });
      const { repo } = (await repoRes.json()) as { repo: Repo };

      const res = await apiFetch(fixture, 'POST', '/api/reviews', { body: { repoId: repo.id } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.message).toContain('branch or sha');
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/reviews requires a valid repoId or repoPath', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'POST', '/api/reviews', { body: { repoId: 'nonexistent-repo-id', branch: 'feature' } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.message).toContain('repoId or a registered repoPath');
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/reviews opening the same branch twice returns the same review (no duplicate created)', async () => {
    const fixture = await setupHttp('feature');
    try {
      const repoRes = await apiFetch(fixture, 'POST', '/api/repos', { body: { path: fixture.repoDir } });
      const { repo } = (await repoRes.json()) as { repo: Repo };

      const first = await apiFetch(fixture, 'POST', '/api/reviews', { body: { repoId: repo.id, branch: 'feature' } });
      const firstJson = (await first.json()) as { review: Review };

      const second = await apiFetch(fixture, 'POST', '/api/reviews', { body: { repoId: repo.id, branch: 'feature' } });
      const secondJson = (await second.json()) as { review: Review };

      expect(secondJson.review.id).toBe(firstJson.review.id);
    } finally {
      await fixture.cleanup();
    }
  });

  test('GET /api/reviews/:id fetches review state; currentRevision resolves to "working" when the branch is attached on disk', async () => {
    const fixture = await setupHttpWithReview('feature');
    try {
      const res = await apiFetch(fixture, 'GET', `/api/reviews/${fixture.review.id}`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { review: Review; repo: Repo; state: ReviewState };
      expect(json.review.id).toBe(fixture.review.id);
      expect(json.state.currentRevision).toBe('working');
      expect(json.state.root.attachedPath).not.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  test('GET /api/reviews/:id returns 404 for an unknown review id', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/reviews/does-not-exist');
      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('not_found');
    } finally {
      await fixture.cleanup();
    }
  });

  test('GET /api/reviews/:id/files returns 404 for an unknown review id', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/reviews/does-not-exist/files');
      expect(res.status).toBe(404);
    } finally {
      await fixture.cleanup();
    }
  });

  test('GET /api/reviews/:id/files lists the file list and viewed rows', async () => {
    const fixture = await setupHttpWithReview('feature');
    try {
      const res = await apiFetch(fixture, 'GET', `/api/reviews/${fixture.review.id}/files`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { list: { files: { path: string }[] }; viewed: unknown[] };
      expect(json.list.files.some((f) => f.path === 'feature.txt')).toBe(true);
      expect(json.viewed).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('GET /api/threads/:id returns 404 for an unknown thread id', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/threads/does-not-exist');
      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('not_found');
    } finally {
      await fixture.cleanup();
    }
  });

  test('GET /api/runs/:id returns 404 for an unknown run id', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'GET', '/api/runs/does-not-exist');
      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('not_found');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('routes.ts: revision endpoint', () => {
  test('POST /api/reviews/:id/revision switches revision and the response reflects the new state', async () => {
    const fixture = await setupHttpWithReview('feature');
    try {
      const stateRes = await apiFetch(fixture, 'GET', `/api/reviews/${fixture.review.id}`);
      const { state } = (await stateRes.json()) as { state: ReviewState };
      expect(state.availableRevisions).toContain('head');

      const res = await apiFetch(fixture, 'POST', `/api/reviews/${fixture.review.id}/revision`, { body: { revision: 'head' } });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { state: ReviewState };
      expect(json.state.currentRevision).toBe('head');
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/reviews/:id/revision rejects a revision that is not currently available with 409', async () => {
    const fixture = await setupHttpWithReview('feature');
    try {
      const res = await apiFetch(fixture, 'POST', `/api/reviews/${fixture.review.id}/revision`, { body: { revision: 'pr' } });
      expect(res.status).toBe(409);
      const json = (await res.json()) as ErrorBody;
      expect(json.error.code).toBe('conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/reviews/:id/revision rejects an invalid revision value with 400', async () => {
    const fixture = await setupHttpWithReview('feature');
    try {
      const res = await apiFetch(fixture, 'POST', `/api/reviews/${fixture.review.id}/revision`, { body: { revision: 'bogus' } });
      expect(res.status).toBe(400);
    } finally {
      await fixture.cleanup();
    }
  });

  test('POST /api/reviews/:id/revision returns 404 for an unknown review id', async () => {
    const fixture = await setupHttp();
    try {
      const res = await apiFetch(fixture, 'POST', '/api/reviews/does-not-exist/revision', { body: { revision: 'head' } });
      expect(res.status).toBe(404);
    } finally {
      await fixture.cleanup();
    }
  });
});
