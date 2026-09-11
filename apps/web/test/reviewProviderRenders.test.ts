/**
 * State-layer smoke test for the centre pane's data path.
 *
 * This is deliberately NOT an end-to-end render test: it never mounts
 * `@pierre/diffs`' `CodeView` (which needs real Web Workers and shadow DOM —
 * see the "what this does NOT cover" note appended to IMPROVEMENTS.md under
 * "render coverage"). What it DOES do is mount the real `ReviewProvider`
 * from `apps/web/src/state/ReviewContext.tsx` — the same component tree the
 * app renders — against a mocked API, using `happy-dom` to give React a real
 * DOM to commit into and `react`'s `act` to flush its effects. It then reads
 * the actual `items` array `ReviewContext` hands to `CodeView`, so a
 * regression that makes item-building silently produce zero (or
 * content-less) items — exactly the class of bug that shipped a blank
 * review — fails this test.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

// --- Register a DOM before importing anything that touches `window` -------
// happy-dom's `GlobalWindow` (this version has no `GlobalRegistrator`) is a
// `Window` subclass that also carries the ambient globals (Array, Object,
// etc.) so `Object.assign(globalThis, window)` is safe. We additionally
// alias the handful of constructors/functions React and our own code touch
// by name, since `Object.assign` copies own enumerable properties but some
// of these are inherited/getter-backed on the window prototype chain.
import GlobalWindowCtor from 'happy-dom/lib/window/GlobalWindow.js';

// `bun test` runs every test file in one shared process/global object, and
// `apps/server`'s tests rely on Bun's own native `WebSocket`/`fetch`/
// `Request`/`Response` (real upgrades, real hono routing). So this only
// installs the exact globals React/ReviewContext touch — deliberately an
// ALLOWLIST, not a sweep of everything `GlobalWindow` carries (an earlier
// version of this test did a blanket `Object.assign(globalThis, window)`,
// which clobbered Bun's native `WebSocket`/`fetch` and broke unrelated
// `apps/server` websocket tests elsewhere in the same `bun test` run — never
// touch globals a Bun-native test file depends on).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = new (GlobalWindowCtor as any)({ url: 'http://localhost/review' });
const g = globalThis as unknown as Record<string, unknown>;
const ALLOWED_KEYS = [
  'HTMLElement',
  'Element',
  'Node',
  'Text',
  'Comment',
  'DocumentFragment',
  'Document',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'customElements',
  'navigator',
  'location',
] as const;
for (const key of ALLOWED_KEYS) {
  g[key] = (win as unknown as Record<string, unknown>)[key];
}
g['window'] = win;
g['document'] = win.document;
g['requestAnimationFrame'] = win.requestAnimationFrame.bind(win);
g['cancelAnimationFrame'] = win.cancelAnimationFrame.bind(win);
g['IS_REACT_ACT_ENVIRONMENT'] = true;

// --- Fixtures ---------------------------------------------------------------

const REVIEW_ID = 'rev_test';

const review = {
  id: REVIEW_ID,
  repoId: 'repo_1',
  branch: 'feature/x',
  pinnedSha: null,
  baseRef: 'main',
  prNumber: null,
  currentRevision: 'working' as const,
  lastSeenPrSha: null,
  status: 'open' as const,
  createdAt: 0,
};

const repo = {
  id: 'repo_1',
  rootPath: '/tmp/repo',
  remoteOwner: null,
  remoteName: null,
  defaultBranch: 'main',
  createdAt: 0,
};

const reviewState = {
  reviewId: REVIEW_ID,
  availableRevisions: ['working', 'head'] as const,
  currentRevision: 'working' as const,
  root: { attachedPath: '/tmp/repo', detachedReason: null },
  divergence: null,
  basesMismatched: false,
  operationInProgress: null,
  prNumber: null,
};

const normalFile = {
  path: 'src/normal.ts',
  oldPath: null,
  status: 'modified' as const,
  oldBlob: 'aaa',
  newBlob: 'bbb',
  binary: false,
  generated: false,
  additions: 5,
  deletions: 2,
};

const largeFile = {
  path: 'src/large.ts',
  oldPath: null,
  status: 'modified' as const,
  oldBlob: 'ccc',
  newBlob: 'ddd',
  binary: false,
  generated: false,
  additions: 3000,
  deletions: 0,
};

const generatedFile = {
  path: 'dist/bundle.js',
  oldPath: null,
  status: 'modified' as const,
  oldBlob: 'eee',
  newBlob: 'fff',
  binary: false,
  generated: true,
  additions: 10,
  deletions: 0,
};

const fileList = [normalFile, largeFile, generatedFile];

function patchFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-old line',
    '+new line',
    ' line3',
    '',
  ].join('\n');
}

// --- Mock the API boundary, not the code under test ------------------------
// `callApi` is the one seam between `ReviewContext`/`diffLoader` and the
// network; everything downstream (item-building, collapse defaults, patch
// parsing via `@pierre/diffs`' real `parsePatchFiles`) runs unmodified.
mock.module('../src/lib/apiClient.ts', () => ({
  ApiError: class ApiError extends Error {},
  setAuthToken: () => undefined,
  getAuthToken: () => null,
  callApi: async (op: string, options: { query?: { path?: string } } = {}) => {
    switch (op) {
      case 'getReview':
        return { review, repo, state: reviewState };
      case 'getFiles':
        return { list: { reviewId: REVIEW_ID, revision: 'working', baseSha: 'base', headSha: 'head', files: fileList }, viewed: [] };
      case 'listThreads':
        return { threads: [] };
      case 'getReadingOrder':
        return { readingOrder: null };
      case 'getDiff': {
        const path = options.query?.path ?? '';
        return { patch: { path, oldPath: null, oldBlob: 'x', newBlob: 'y', binary: false, patch: patchFor(path), oldMode: null, newMode: null } };
      }
      default:
        throw new Error(`unexpected callApi op in test: ${op}`);
    }
  },
}));

// The live-update transport is irrelevant to whether the initial item list
// renders; stub it out so `ReviewProvider`'s mount effect doesn't try to
// open a real WebSocket against a nonexistent server.
mock.module('../src/lib/wsClient.ts', () => ({
  eventsClient: {
    connect: () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    focus: () => undefined,
    blur: () => undefined,
    onEvent: () => () => undefined,
    close: () => undefined,
  },
}));

describe('ReviewProvider renders a non-empty item list', () => {
  let container: HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let root: any;
  let capturedEngine: unknown;

  beforeAll(async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ReviewProvider, useReview } = await import('../src/state/ReviewContext.tsx');

    function Consumer(): null {
      capturedEngine = useReview();
      return null;
    }

    container = win.document.createElement('div');
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as Element);

    await React.act(async () => {
      root.render(
        React.createElement(ReviewProvider, { reviewId: REVIEW_ID }, React.createElement(Consumer)),
      );
    });
    // Flush the microtasks the mocked `callApi` promises and the follow-up
    // `loadFileDiff` calls need, then let React commit the resulting state
    // updates — a couple of ticks is enough since nothing here is a real
    // network round trip.
    for (let i = 0; i < 10; i++) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  });

  afterAll(async () => {
    const React = await import('react');
    await React.act(async () => {
      root?.unmount();
    });
  });

  it('is not loading and has no error after the initial load resolves', () => {
    const engine = capturedEngine as { loading: boolean; error: string | null };
    expect(engine.loading).toBe(false);
    expect(engine.error).toBeNull();
  });

  it('produces one CodeView item per changed file — the blank-pane regression made this empty', () => {
    const engine = capturedEngine as { items: { id: string }[] };
    expect(engine.items.length).toBe(fileList.length);
    const ids = engine.items.map((i) => i.id).sort();
    expect(ids).toEqual(fileList.map((f) => f.path).sort());
  });

  it('loads real patch content into each item, not just placeholders', () => {
    // `loadFileDiff` parses the mocked `getDiff` patch with `@pierre/diffs`'
    // real `parsePatchFiles` — `fileDiff.isPartial` stays `true` by design
    // (full hydration is a separate "expand context" step, see
    // `diffLoader.ts`), so the loaded-vs-placeholder signal is the parsed
    // hunk content and the cache key losing its `:loading` placeholder
    // suffix (`placeholderFileDiff`'s `cacheKey` ends with `:loading`).
    const engine = capturedEngine as {
      items: { id: string; fileDiff: { hunks: unknown[]; cacheKey: string } }[];
    };
    for (const item of engine.items) {
      expect(item.fileDiff.cacheKey.endsWith(':loading')).toBe(false);
      expect(item.fileDiff.hunks.length).toBeGreaterThan(0);
    }
  });

  it('applies the SPEC §6 collapse defaults', () => {
    const engine = capturedEngine as { items: { id: string; collapsed?: boolean }[] };
    const byId = new Map(engine.items.map((i) => [i.id, i.collapsed ?? false]));
    expect(byId.get('src/normal.ts')).toBe(false);
    expect(byId.get('src/large.ts')).toBe(true);
    expect(byId.get('dist/bundle.js')).toBe(true);
  });
});
