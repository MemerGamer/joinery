/**
 * Review-window state: the file list, the `CodeView` item map, staged
 * live-update refresh, revision switching, and panel/UI state.
 *
 * The file list is the state: there is no snapshot hash, so change
 * detection is `diffFileLists` against the list already held, and `changed`
 * entries mutate that item's `fileDiff` in place plus bump `item.version` —
 * never a fresh object, or `CodeView` and the virtualizer both lose their
 * place.
 *
 * The full invariant for touching an item already in `itemsRef`, every
 * time, with no exceptions: mutate its fields in place, bump `item.version`,
 * and call `notifyItemMutated(item)`. That third step is not optional — the
 * React wrapper's controlled `items` prop is reconciled by
 * `areItemListsEqual`, which compares the array *and each element* by
 * reference (`@pierre/diffs/dist/react/CodeView.js`); since we always mutate
 * the same object rather than replacing it, that comparison reports "no
 * change" and `CodeView` never calls `setItems()`/reads the bumped
 * `version` — the mutation is invisible to it, however long `setItemsVersion`
 * takes to eventually re-render. `notifyItemMutated` calls the core
 * instance's own `updateItem()` (via `codeViewRef.current.getInstance()`,
 * which is not gated by the "cannot be used when controlled" check that
 * guards the React imperative handle's `updateItem`) so the change reconciles
 * and repaints immediately regardless of when — or whether — an unrelated
 * membership change happens to re-render the item list. A mutation that
 * lands before `CodeView` has mounted needs no such nudge: `getInstance()`
 * is `undefined` then, but the item is the same object the mount effect's
 * initial `setItems()` call will read, so the already-applied mutation is
 * simply part of what it sees.
 */
import {
  applyDelta,
  diffFileLists,
  isEmptyDelta,
  type AgentRun,
  type FileEntry,
  type FileListDelta,
  type ReactionKind,
  type ReadingOrder,
  type Revision,
  type Review,
  type ReviewState,
  type Repo,
  type Thread,
} from '@review/core';
import type { CodeViewDiffItem, DiffLineAnnotation } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getAgentModel } from '../lib/agentModel.ts';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { blobPairKey, loadFileDiff, placeholderFileDiff } from '../lib/diffLoader.ts';
import { toggleReactionLocally } from '../lib/reactions.ts';
import { localRun } from '../lib/runState.ts';
import { eventsClient } from '../lib/wsClient.ts';

export type DiffStyle = 'split' | 'unified';

/**
 * Per-file collapse overrides an explicit user choice — click a file's
 * header chevron, or the `z` shortcut — as opposed to the automatic
 * binary/generated/large-file default `ensureItem` applies otherwise
 * Persisted per review so it survives reloads and live updates:
 * a file the user expanded stays expanded when its content changes, and
 * vice versa. Keyed by path; `true` = explicitly collapsed, `false` =
 * explicitly expanded.
 */
function collapseStorageKey(reviewId: string): string {
  return `review-ui:collapsed:${reviewId}`;
}

function isCollapseOverrideRecord(value: unknown): value is Record<string, boolean> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((v) => typeof v === 'boolean');
}

/** Reads `localStorage` defensively — it throws in some privacy contexts. */
function readStoredCollapseOverrides(reviewId: string): Map<string, boolean> {
  try {
    const raw = window.localStorage.getItem(collapseStorageKey(reviewId));
    if (raw === null) return new Map();
    const parsed: unknown = JSON.parse(raw);
    return isCollapseOverrideRecord(parsed) ? new Map(Object.entries(parsed)) : new Map();
  } catch {
    return new Map();
  }
}

function persistCollapseOverrides(reviewId: string, overrides: ReadonlyMap<string, boolean>): void {
  try {
    window.localStorage.setItem(
      collapseStorageKey(reviewId),
      JSON.stringify(Object.fromEntries(overrides)),
    );
  } catch {
    // Best-effort only — private/locked-down storage just won't persist.
  }
}

export interface ViewportAnchor {
  path: string;
  side: 'old' | 'new';
  line: number;
}

export interface ThreadAnnotationMeta {
  threadId: string;
}

export interface DraftThread {
  path: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
}

export const DRAFT_THREAD_ID = '__draft__';

interface ReviewEngineState {
  loading: boolean;
  error: string | null;
  review: Review | null;
  repo: Repo | null;
  reviewState: ReviewState | null;
  fileList: FileEntry[];
  viewed: Map<string, string>;
  threads: Thread[];
  readingOrder: ReadingOrder | null;
  pendingDelta: FileListDelta | null;
  /**
   * The revision the user has asked for while its file list is still in
   * flight, or `null` when what's painted matches what's selected. The
   * picker paints this as the selected button immediately so a
   * click acknowledges itself without waiting for the round trip;
   * `reviewState.currentRevision` stays the server's truth.
   */
  pendingRevision: Revision | null;
  /**
   * The latest known run for this review's reading-order generation — drives
   * the Generate button's pending/error feedback. `null` means
   * no generation is in flight and none has failed since the last success.
   * Never read `.status`/`.error` off the `generateReadingOrder` API
   * response directly outside this file; go through `runUiState` (see
   * `lib/runState.ts`) so callers can't special-case today's error text.
   */
  readingOrderRun: AgentRun | null;
  /**
   * Live `thread_reply` runs, keyed by thread id. Fed by
   * `run.started`/`run.delta`/`run.ended`; a thread with no live run (or none
   * since load) simply has no entry. `lastDelta`
   * is the concatenation of that run's `run.delta` text, trimmed to the
   * last ~200 chars, for the "Thinking…" row's live preview.
   */
  threadRuns: Map<string, { run: AgentRun; lastDelta: string }>;
}

export interface ReviewEngine extends ReviewEngineState {
  items: CodeViewDiffItem<ThreadAnnotationMeta>[];
  diffStyle: DiffStyle;
  setDiffStyle: (style: DiffStyle) => void;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  threadsPanelOpen: boolean;
  /** Whether inline comment threads render in the diff at all. */
  commentsVisible: boolean;
  toggleComments: () => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setThreadsPanelOpen: (open: boolean) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleThreadsPanel: () => void;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  /**
   * The reading-order step the reader is on (`n`/`p`), by step id.
   * Set by `n`/`p` and by clicking a file inside a step; `null` until then.
   * Only a hint — a stale id (after regeneration) simply matches no step.
   */
  currentStepId: string | null;
  setCurrentStepId: (id: string | null) => void;
  /**
   * The "current thread" for `r` (resolve) and the start point for `]`/`[`:
   * the thread last navigated to with `]`/`[` or the threads panel, or last
   * clicked/focused inline. `null` when there is none.
   */
  activeThreadId: string | null;
  setActiveThreadId: (id: string | null) => void;
  setRevision: (revision: Revision) => Promise<void>;
  /** Set a file's "viewed" check explicitly. */
  setViewed: (path: string, viewed: boolean) => Promise<void>;
  /** Flip a file's "viewed" check — what the `v` key and the header box do. */
  toggleViewed: (path: string) => Promise<void>;
  isViewed: (entry: FileEntry) => boolean;
  applyPendingRefresh: () => void;
  pendingCount: number;
  reloadThreads: () => Promise<void>;
  reloadReadingOrder: () => Promise<void>;
  reloadAll: () => Promise<void>;
  /**
   * Kick off reading-order generation and track its outcome in
   * `readingOrderRun` (pending immediately, then whatever the server ends
   * up reporting — including a genuinely-thrown network/non-2xx failure,
   * synthesized into the same run shape so callers have one code path).
   * Both call sites (the pane's Generate button and the command palette)
   * should call this instead of `callApi('generateReadingOrder', ...)`
   * directly, so the outcome is never silently dropped.
   */
  generateReadingOrder: () => Promise<void>;
  /**
   * The explicit "Ask agent" trigger (the Ask button on a thread card, or
   * the composer's "Ask" split button via `submitDraftThread`/`reply`'s own
   * `askAgent` flag — this action is only the former, standalone case).
   * Seeds a local pending run into `threadRuns` immediately, same pattern as
   * `generateReadingOrder`, then reconciles with whatever the POST (or a
   * `run.started`/`run.ended` event for the same run) reports.
   */
  askAgent: (threadId: string) => Promise<void>;
  /** Toggle the *user's* reaction on a comment; `ReactionBar` is the only caller. */
  setReaction: (commentId: string, kind: ReactionKind, on: boolean) => Promise<void>;
  /**
   * Moves a `draft`/`archived` review to `open` so it starts showing up on
   * Homebase. A no-op when there's no review loaded yet or it's already
   * `open`. Errors are not folded into
   * `state.error` (that channel is for "the review failed to load", a
   * different failure the whole window reacts to) — they're rethrown so the
   * Header's button can show its own transient message instead.
   */
  startReview: () => Promise<void>;
  bumpAnnotations: (path: string) => void;
  annotationsByPath: Map<string, DiffLineAnnotation<ThreadAnnotationMeta>[]>;
  draftThread: DraftThread | null;
  startDraftThread: (draft: DraftThread) => void;
  cancelDraftThread: () => void;
  submitDraftThread: (bodyMd: string, askAgent: boolean) => Promise<void>;
  codeViewRef: React.RefObject<CodeViewHandle<ThreadAnnotationMeta, undefined> | null>;
  /** Toggle one file's collapsed state — an explicit, persisted choice. */
  toggleFileCollapsed: (path: string) => void;
  /**
   * Expand a file if it is currently collapsed, without recording it as an
   * explicit user choice — used when navigating to a file (FileTreePane)
   * so selection never lands on a collapsed diff.
   */
  expandFileForNavigation: (path: string) => void;
  /** Collapse every file not already collapsed (bulk, not persisted). */
  collapseAllFiles: () => void;
  /**
   * Expand every file not already expanded, except files collapsed by the
   * automatic binary/generated/large default that the user hasn't
   * overridden — those are excluded from any "expand all" action.
   */
  expandAllFiles: () => void;
}

const ReviewCtx = createContext<ReviewEngine | null>(null);

export function useReview(): ReviewEngine {
  const ctx = useContext(ReviewCtx);
  if (ctx === null) throw new Error('useReview must be used within ReviewProvider');
  return ctx;
}

interface ItemRecord {
  entry: FileEntry;
  item: CodeViewDiffItem<ThreadAnnotationMeta>;
}

export function ReviewProvider({
  reviewId,
  children,
}: {
  reviewId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [state, setState] = useState<ReviewEngineState>({
    loading: true,
    error: null,
    review: null,
    repo: null,
    reviewState: null,
    fileList: [],
    viewed: new Map(),
    threads: [],
    readingOrder: null,
    pendingDelta: null,
    pendingRevision: null,
    readingOrderRun: null,
    threadRuns: new Map(),
  });

  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [threadsPanelOpen, setThreadsPanelOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [draftThread, setDraftThread] = useState<DraftThread | null>(null);
  const codeViewRef = useRef<CodeViewHandle<ThreadAnnotationMeta, undefined> | null>(null);

  // Every in-place item mutation must call this afterward (see the module
  // doc comment above). If CodeView hasn't mounted yet, getInstance() is
  // undefined and there's nothing to nudge — harmless, since the mount
  // effect's own setItems() call will read the item's current (already
  // mutated) content.
  const notifyItemMutated = useCallback((item: CodeViewDiffItem<ThreadAnnotationMeta>) => {
    codeViewRef.current?.getInstance()?.updateItem(item);
  }, []);

  // The item map — module-scoped per provider instance, mutated in place.
  // `itemsVersion` forces the memoized `items` array to recompute only when
  // membership/order changes, never on a pure content mutation (that's
  // handled by the per-item `version` counter Pierre reconciles on).
  const itemsRef = useRef<Map<string, ItemRecord>>(new Map());
  const [itemsVersion, setItemsVersion] = useState(0);
  // Bumped by every `rebuildOrder` call (regardless of membership change) to
  // schedule the placeholder-patch-loading effect below. Patch fetches must
  // start from that effect, not from inside `rebuildOrder` itself: a fetch
  // that resolves fast (cache hit) calls back into `notifyItemMutated`, which
  // requires the item already be registered with `CodeView` — true only
  // once the render triggered by this rebuild has committed and `CodeView`'s
  // own layout effect has run, which is guaranteed by the time *any* effect
  // (including this one) fires.
  const [loadTick, setLoadTick] = useState(0);
  const orderRef = useRef<string[]>([]);

  // Explicit per-file collapse choices (path -> collapsed), persisted to
  // localStorage per review. Reloaded whenever `reviewId` changes, below.
  const collapseOverridesRef = useRef<Map<string, boolean>>(readStoredCollapseOverrides(reviewId));

  const revision = state.reviewState?.currentRevision;
  const revisionRef = useRef<Revision | undefined>(revision);
  revisionRef.current = revision;

  const annotationsRef = useRef<Map<string, DiffLineAnnotation<ThreadAnnotationMeta>[]>>(
    new Map(),
  );
  const [annotationsVersion, setAnnotationsVersion] = useState(0);

  const draftRef = useRef<DraftThread | null>(null);
  draftRef.current = draftThread;
  const [commentsVisible, setCommentsVisible] = useState(true);
  const commentsVisibleRef = useRef(true);
  commentsVisibleRef.current = commentsVisible;

  const buildAnnotationsFor = useCallback(
    (path: string, threads: Thread[]): DiffLineAnnotation<ThreadAnnotationMeta>[] => {
      // Hidden comments drop out of the annotation set entirely (the
      // draft composer stays, since you just asked for it).
      const fromThreads = (commentsVisibleRef.current ? threads : [])
        .filter((t) => t.path === path)
        .map((t) => ({
          side: t.side === 'old' ? ('deletions' as const) : ('additions' as const),
          // Anchored after the *last* selected line, so the card never
          // sits above the code it discusses.
          lineNumber: t.endLine,
          metadata: { threadId: t.id },
        }));
      const draft = draftRef.current;
      if (draft !== null && draft.path === path) {
        fromThreads.push({
          side: draft.side === 'old' ? 'deletions' : 'additions',
          lineNumber: draft.endLine,
          metadata: { threadId: DRAFT_THREAD_ID },
        });
      }
      return fromThreads;
    },
    [],
  );

  const ensureItem = useCallback(
    (entry: FileEntry, threads: Thread[]) => {
      const existing = itemsRef.current.get(entry.path);
      const annotations = buildAnnotationsFor(entry.path, threads);
      annotationsRef.current.set(entry.path, annotations);
      if (existing === undefined) {
        // The automatic default applies only to files the user
        // has never touched — an explicit override always wins, so a file
        // the user expanded stays expanded across a live update that
        // recreates its item (e.g. removed then re-added).
        const override = collapseOverridesRef.current.get(entry.path);
        const item: CodeViewDiffItem<ThreadAnnotationMeta> = {
          id: entry.path,
          type: 'diff',
          fileDiff: placeholderFileDiff(entry),
          annotations,
          version: 0,
          collapsed: override ?? (entry.binary || entry.generated || isLargeFile(entry)),
        };
        itemsRef.current.set(entry.path, { entry, item });
        return true;
      }
      // The path is the same, but this may be a *new* `FileEntry` for it —
      // a live update re-delivers changed files with new blob SHAs. Adopt it,
      // or `rec.entry` keeps the pre-update blobs and the patch-loading effect
      // below has no way to tell the rendered diff is stale.
      existing.entry = entry;
      existing.item.annotations = annotations;
      existing.item.version = (existing.item.version ?? 0) + 1;
      notifyItemMutated(existing.item);
      return false;
    },
    [buildAnnotationsFor, notifyItemMutated],
  );

  const loadPatchInto = useCallback((entry: FileEntry) => {
    if (entry.binary) return;
    const rev = revisionRef.current;
    loadFileDiff(reviewId, entry, rev)
      .then((fileDiff) => {
        const rec = itemsRef.current.get(entry.path);
        if (rec === undefined) return;
        rec.item.fileDiff = fileDiff;
        rec.item.version = (rec.item.version ?? 0) + 1;
        notifyItemMutated(rec.item);
        setItemsVersion((v) => v + 1);
      })
      .catch(() => {
        // Leave the placeholder in place; the file simply stays unloaded.
      });
  }, [reviewId, notifyItemMutated]);

  const rebuildOrder = useCallback((fileList: FileEntry[], threads: Thread[]) => {
    let changedMembership = false;
    const nextIds = fileList.map((f) => f.path);
    for (const entry of fileList) {
      const isNew = ensureItem(entry, threads);
      if (isNew) changedMembership = true;
    }
    const nextSet = new Set(nextIds);
    for (const id of itemsRef.current.keys()) {
      if (!nextSet.has(id)) {
        itemsRef.current.delete(id);
        changedMembership = true;
      }
    }
    if (orderRef.current.join('\0') !== nextIds.join('\0')) changedMembership = true;
    orderRef.current = nextIds;
    if (changedMembership) setItemsVersion((v) => v + 1);
    setLoadTick((v) => v + 1);
  }, [ensureItem]);

  // Load patches for any item whose diff isn't the one its current `FileEntry`
  // describes, deferred to an effect so it always runs after the render
  // `rebuildOrder` triggered has committed (see the `loadTick` comment above)
  // — never inline inside `rebuildOrder`.
  //
  // The test is the blob pair rather than "is this still a placeholder": that
  // covers the first load (a placeholder's `cacheKey` is deliberately suffixed
  // so it never matches) *and* the live-update case, where a file that already
  // has a real patch was changed on disk and needs a fresh one. Checking only
  // for placeholders left `changed` files rendering their pre-update diff
  // forever, since the refresh gave them new blobs but never refetched.
  useEffect(() => {
    for (const rec of itemsRef.current.values()) {
      if (rec.item.fileDiff.cacheKey !== blobPairKey(rec.entry)) {
        loadPatchInto(rec.entry);
      }
    }
  }, [loadTick, loadPatchInto]);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [detail, filesRes, threadsRes, readingOrderRes] = await Promise.all([
        callApi('getReview', { params: [reviewId] }),
        callApi('getFiles', { params: [reviewId] }),
        callApi('listThreads', { params: [reviewId] }),
        callApi('getReadingOrder', { params: [reviewId] }),
      ]);
      const viewed = new Map(filesRes.viewed.map((v) => [v.path, v.blobSha] as const));
      setState({
        loading: false,
        error: null,
        review: detail.review,
        repo: detail.repo,
        reviewState: detail.state,
        fileList: filesRes.list.files,
        viewed,
        threads: threadsRes.threads,
        readingOrder: readingOrderRes.readingOrder,
        pendingDelta: null,
        pendingRevision: null,
        readingOrderRun: null,
        threadRuns: new Map(),
      });
      rebuildOrder(filesRes.list.files, threadsRes.threads);
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof ApiError ? err.message : 'Failed to load review',
      }));
    }
  }, [reviewId, rebuildOrder]);

  useEffect(() => {
    itemsRef.current = new Map();
    orderRef.current = [];
    collapseOverridesRef.current = readStoredCollapseOverrides(reviewId);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

  // Live updates: subscribe, and stage rather than apply.
  useEffect(() => {
    eventsClient.connect();
    eventsClient.subscribe(reviewId);
    eventsClient.focus(reviewId);

    const unsubscribe = eventsClient.onEvent((event) => {
      if (!('reviewId' in event) || event.reviewId !== reviewId) return;
      switch (event.type) {
        case 'files.changed': {
          setState((s) => {
            // Another tab may be watching a different revision of this same
            // review — the server tags every list with its revision rather
            // than filtering perfectly on its own, so this tab only ever
            // applies updates for the revision it's actually showing.
            if (s.reviewState !== null && event.list.revision !== s.reviewState.currentRevision) return s;
            const delta = diffFileLists(s.fileList, event.list.files);
            if (isEmptyDelta(delta)) return s;
            return { ...s, pendingDelta: delta };
          });
          break;
        }
        case 'root.rebound': {
          // `event.state` is a global, server-wide snapshot — but
          // `currentRevision` on it reflects the review's persisted default,
          // not necessarily what *this* tab is looking at (another tab may
          // have switched it). Keep every other field fresh; preserve this
          // tab's own revision choice so a background broadcast never yanks
          // the view out from under a tab that picked something else.
          setState((s) => ({
            ...s,
            reviewState:
              s.reviewState === null
                ? event.state
                : { ...event.state, currentRevision: s.reviewState.currentRevision },
          }));
          break;
        }
        case 'remote.moved': {
          setState((s) =>
            s.reviewState === null
              ? s
              : { ...s, reviewState: { ...s.reviewState, divergence: event.divergence } },
          );
          break;
        }
        case 'thread.created':
        case 'thread.updated': {
          setState((s) => {
            const idx = s.threads.findIndex((t) => t.id === event.thread.id);
            const threads =
              idx === -1
                ? [...s.threads, event.thread]
                : s.threads.map((t, i) => (i === idx ? event.thread : t));
            return { ...s, threads };
          });
          break;
        }
        case 'thread.relocated': {
          setState((s) => {
            const byId = new Map(event.threads.map((t) => [t.id, t]));
            return { ...s, threads: s.threads.map((t) => byId.get(t.id) ?? t) };
          });
          break;
        }
        case 'reading_order.updated': {
          callApi('getReadingOrder', { params: [reviewId] })
            .then((res) => setState((s) => ({ ...s, readingOrder: res.readingOrder })))
            .catch(() => undefined);
          break;
        }
        case 'run.started':
        case 'run.ended': {
          if (event.run.kind === 'reading_order') {
            setState((s) => ({ ...s, readingOrderRun: event.run }));
            break;
          }
          // thread_reply: keyed by threadId in `threadRuns`, not this pane's
          // single `readingOrderRun` slot — a review can have many live at
          // once. `threadId` is always set for this kind (R3); the guard is
          // just to satisfy the type.
          if (event.run.kind === 'thread_reply' && event.run.threadId !== null) {
            const threadId = event.run.threadId;
            setState((s) => {
              const threadRuns = new Map(s.threadRuns);
              threadRuns.set(threadId, { run: event.run, lastDelta: threadRuns.get(threadId)?.lastDelta ?? '' });
              return { ...s, threadRuns };
            });
          }
          break;
        }
        case 'run.delta': {
          // The delta payload carries `{ text }`, kept as `unknown` on the
          // wire (events.ts) so the UI can render what it knows without the
          // schema pinning the SDK's message shape — read it defensively.
          const text = extractDeltaText(event.payload);
          if (text === null) break;
          setState((s) => {
            let threadId: string | null = null;
            for (const [tid, entry] of s.threadRuns) {
              if (entry.run.id === event.runId) {
                threadId = tid;
                break;
              }
            }
            if (threadId === null) return s;
            const threadRuns = new Map(s.threadRuns);
            const prev = threadRuns.get(threadId);
            if (prev === undefined) return s;
            threadRuns.set(threadId, { run: prev.run, lastDelta: (prev.lastDelta + text).slice(-200) });
            return { ...s, threadRuns };
          });
          break;
        }
        default:
          break;
      }
    });

    const onFocus = () => eventsClient.focus(reviewId);
    const onBlur = () => eventsClient.blur(reviewId);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    return () => {
      unsubscribe();
      eventsClient.unsubscribe(reviewId);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [reviewId]);

  // Keep this connection's revision filter in sync with what this tab is
  // actually showing — re-sent as an upsert (see `EventsClient.subscribe`)
  // whenever it changes, including the first time it becomes known after
  // `load()` resolves. Independent of the mount/unmount effect above so it
  // doesn't tear down and recreate the subscription on every switch.
  useEffect(() => {
    if (revision !== undefined) eventsClient.subscribe(reviewId, revision);
  }, [reviewId, revision]);

  // Re-derive annotations whenever the thread list (or the draft) changes —
  // but touch only the paths that could actually be affected: the ones with
  // threads, the draft's current path, and the draft's previous path (so a
  // cancelled/moved draft's stale annotation gets cleared there too). Every
  // other path's annotations are left completely alone so clicking the
  // gutter `+` doesn't force `CodeView` to reconcile and re-highlight the
  // entire file list (that was the "comment button is slow" bug).
  const prevDraftPathRef = useRef<string | null>(null);
  useEffect(() => {
    const candidatePaths = new Set<string>();
    for (const t of state.threads) candidatePaths.add(t.path);
    if (draftThread !== null) candidatePaths.add(draftThread.path);
    if (prevDraftPathRef.current !== null) candidatePaths.add(prevDraftPathRef.current);
    prevDraftPathRef.current = draftThread?.path ?? null;

    let anyChanged = false;
    for (const path of candidatePaths) {
      const next = buildAnnotationsFor(path, state.threads);
      const prev = annotationsRef.current.get(path) ?? [];
      if (annotationsEqual(prev, next)) continue;
      annotationsRef.current.set(path, next);
      const rec = itemsRef.current.get(path);
      if (rec !== undefined) {
        rec.item.annotations = next;
        rec.item.version = (rec.item.version ?? 0) + 1;
        notifyItemMutated(rec.item);
      }
      anyChanged = true;
    }
    if (anyChanged) {
      setAnnotationsVersion((v) => v + 1);
      setItemsVersion((v) => v + 1);
    }
    // `commentsVisible` is read through a ref inside `buildAnnotationsFor`;
    // it is listed here so toggling re-derives every thread path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.threads, draftThread, notifyItemMutated, commentsVisible]);

  const applyPendingRefresh = useCallback(() => {
    // Viewport anchor (scroll and selection stability): capture the
    // topmost visible file before applying the delta, then restore it (or
    // the nearest surviving file in reading order if it was removed) after
    // the item list is rebuilt — never a pixel offset, so it survives the
    // reflow that comes from files being added/removed above it.
    const previousOrder = orderRef.current;
    const anchorPath = captureTopVisiblePath(codeViewRef.current);

    setState((s) => {
      if (s.pendingDelta === null) return s;
      const nextFiles = applyDelta(s.fileList, s.pendingDelta);
      rebuildOrder(nextFiles, s.threads);
      return { ...s, fileList: nextFiles, pendingDelta: null };
    });

    if (anchorPath !== null) {
      requestAnimationFrame(() => {
        const target = itemsRef.current.has(anchorPath)
          ? anchorPath
          : nearestSurvivingPath(anchorPath, previousOrder, itemsRef.current);
        if (target !== null) {
          codeViewRef.current?.scrollTo({ type: 'item', id: target, align: 'start' });
        }
      });
    }
  }, [rebuildOrder]);

  /**
   * The revision the user last asked for, and whether a switch is already
   * working through it. Together these serialize switching: clicking
   * faster than the round trip never interleaves two switches, and only the
   * newest selection's file list is ever painted (see `setRevision`).
   */
  const revisionTargetRef = useRef<Revision | null>(null);
  const revisionRunningRef = useRef(false);

  const setRevision = useCallback(
    async (nextRevision: Revision) => {
      // Acknowledge the click immediately — the picker paints `pendingRevision`
      // as selected, so the button doesn't wait on the round trip to light up.
      revisionTargetRef.current = nextRevision;
      setState((s) => ({ ...s, pendingRevision: nextRevision }));

      // A switch is already in flight: it re-reads the target after each
      // await, so it will pick this one up. Starting a second loop here is
      // exactly the race we're avoiding — `POST /revision` mutates server
      // state, so two concurrent switches can land out of order and leave
      // the server on a revision the user already clicked away from.
      if (revisionRunningRef.current) return;
      revisionRunningRef.current = true;
      try {
        while (revisionTargetRef.current !== null) {
          const target: Revision = revisionTargetRef.current;
          try {
            // The target revision's file list rides along in the response —
            // every available revision is kept warm server-side, so there's
            // no need for a second `getFiles` round trip here. `viewed` isn't
            // revision-scoped (keyed by path+blob, compared per-entry by
            // `isViewed`), so it carries over unchanged.
            const res = await callApi('setRevision', {
              params: [reviewId],
              body: { revision: target },
            });
            // Superseded mid-flight — loop around for the newer target
            // rather than painting a file list nobody will look at. The
            // `continue` deliberately leaves the target set.
            if (revisionTargetRef.current !== target) continue;
            // Thread positions are only persisted against the review's
            // default revision — switching away from it needs a projected
            // re-fetch, since the
            // threads this tab was holding may be positioned for whichever
            // revision it was on before.
            const threadsRes = await callApi('listThreads', {
              params: [reviewId],
              query: { rev: target },
            });
            if (revisionTargetRef.current !== target) continue;
            setState((s) => ({
              ...s,
              reviewState: res.state,
              fileList: res.list.files,
              threads: threadsRes.threads,
              pendingDelta: null,
              pendingRevision: null,
            }));
            itemsRef.current = new Map();
            rebuildOrder(res.list.files, threadsRes.threads);
          } catch {
            if (revisionTargetRef.current !== target) continue;
            // Surfaced via reviewState staying unchanged; a banner-level retry
            // affordance is left to the header component. The pending mark has
            // to clear either way, or the picker sweeps forever.
            setState((s) => ({ ...s, pendingRevision: null }));
          }
          revisionTargetRef.current = null;
        }
      } finally {
        revisionRunningRef.current = false;
      }
    },
    [reviewId, rebuildOrder],
  );

  const isViewed = useCallback(
    (entry: FileEntry) => state.viewed.get(entry.path) === entry.newBlob,
    [state.viewed],
  );

  // The check is keyed by `(path, blob)`, so unchecking deletes the row
  // for the blob the user is actually looking at rather than clearing the
  // path outright — a stale check for some older blob was already not a match
  // and must stay that way.
  const setViewed = useCallback(
    async (path: string, viewed: boolean) => {
      const entry = state.fileList.find((f) => f.path === path);
      if (entry === undefined) return;
      setState((s) => {
        const next = new Map(s.viewed);
        if (viewed) next.set(path, entry.newBlob);
        else next.delete(path);
        return { ...s, viewed: next };
      });
      try {
        await callApi('markViewed', {
          params: [reviewId],
          body: { path, blobSha: entry.newBlob, viewed },
        });
      } catch {
        // Optimistic; a reconcile pass on next load corrects drift.
      }
    },
    [reviewId, state.fileList],
  );

  const reloadThreads = useCallback(async () => {
    // Scoped to this tab's own revision — positions for any revision other
    // than the review's persisted one are projected server-side at read
    // time, never persisted.
    const rev = revisionRef.current;
    const res = await callApi('listThreads', {
      params: [reviewId],
      query: rev === undefined ? {} : { rev },
    });
    setState((s) => ({ ...s, threads: res.threads }));
  }, [reviewId]);

  const reloadReadingOrder = useCallback(async () => {
    const res = await callApi('getReadingOrder', { params: [reviewId] });
    setState((s) => ({ ...s, readingOrder: res.readingOrder }));
  }, [reviewId]);

  const generateReadingOrder = useCallback(async () => {
    // Optimistic pending feedback the instant the click registers, before
    // the POST (or the `run.started` event it triggers server-side) lands —
    // generation can take a while and the button must not look inert.
    setState((s) => ({ ...s, readingOrderRun: localRun(reviewId, 'pending') }));
    try {
      const res = await callApi('generateReadingOrder', { params: [reviewId], body: {} });
      // The response's `run` is the just-started one (`running`); the
      // agent finishes in the background and its `run.ended` WS event
      // carries the outcome. Let `runUiState` (lib/runState.ts) interpret
      // whichever copy is newest — `laterRun` keeps an end that already
      // arrived from being undone by this response.
      setState((s) => ({ ...s, readingOrderRun: laterRun(s.readingOrderRun, res.run) }));
    } catch (err) {
      // Genuinely thrown: network failure or non-2xx, no run object at all.
      setState((s) => ({
        ...s,
        readingOrderRun: localRun(
          reviewId,
          'error',
          err instanceof ApiError ? err.message : 'Could not reach the server.',
        ),
      }));
    }
  }, [reviewId]);

  const askAgent = useCallback(
    async (threadId: string) => {
      const pending: AgentRun = {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        reviewId,
        threadId,
        kind: 'thread_reply',
        status: 'pending',
        sessionId: null,
        startedAt: Date.now(),
        endedAt: null,
        error: null,
      };
      setState((s) => {
        const threadRuns = new Map(s.threadRuns);
        threadRuns.set(threadId, { run: pending, lastDelta: '' });
        return { ...s, threadRuns };
      });
      try {
        const res = await callApi('askAgent', { params: [threadId], body: { model: getAgentModel() } });
        setState((s) => {
          const threadRuns = new Map(s.threadRuns);
          const prev = threadRuns.get(threadId);
          threadRuns.set(threadId, { run: laterRun(prev?.run ?? null, res.run), lastDelta: prev?.lastDelta ?? '' });
          return { ...s, threadRuns };
        });
      } catch (err) {
        // Genuinely thrown: network failure or non-2xx, no server-side run
        // at all — synthesize one so the live row can show the failure
        // instead of hanging on "Thinking…" forever.
        setState((s) => {
          const threadRuns = new Map(s.threadRuns);
          threadRuns.set(threadId, {
            run: {
              id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              reviewId,
              threadId,
              kind: 'thread_reply',
              status: 'error',
              sessionId: null,
              startedAt: Date.now(),
              endedAt: Date.now(),
              error: err instanceof ApiError ? err.message : 'Could not reach the server.',
            },
            lastDelta: '',
          });
          return { ...s, threadRuns };
        });
      }
    },
    [reviewId],
  );

  const setReaction = useCallback(async (commentId: string, kind: ReactionKind, on: boolean) => {
    setState((s) => ({
      ...s,
      threads: s.threads.map((t) => ({
        ...t,
        comments: t.comments.map((c) =>
          c.id === commentId ? { ...c, reactions: toggleReactionLocally(c.reactions, kind, 'user', on) } : c,
        ),
      })),
    }));
    try {
      const res = await callApi('setReaction', { params: [commentId], body: { kind, actor: 'user', on } });
      setState((s) => ({
        ...s,
        threads: s.threads.map((t) => (t.id === res.thread.id ? res.thread : t)),
      }));
    } catch {
      // Optimistic, like `setViewed` — a later `thread.updated` or reload
      // corrects any drift rather than surfacing a transient error here.
    }
  }, []);

  const startReview = useCallback(async () => {
    if (state.review === null || state.review.status === 'open') return;
    const res = await callApi('setReviewStatus', {
      params: [reviewId],
      body: { status: 'open' },
    });
    setState((s) => ({ ...s, review: res.review }));
  }, [reviewId, state.review]);

  const bumpAnnotations = useCallback(
    (path: string) => {
      const rec = itemsRef.current.get(path);
      if (rec === undefined) return;
      rec.item.version = (rec.item.version ?? 0) + 1;
      notifyItemMutated(rec.item);
      setItemsVersion((v) => v + 1);
    },
    [notifyItemMutated],
  );

  // Mutate `rec.item.collapsed` in place, bump its version, and force the
  // core CodeView instance to reconcile that one item immediately (see the
  // module doc comment above on why `setItemsVersion` alone isn't enough).
  // `persist` records the change as an explicit user choice; navigation
  // convenience (FileTreePane) and bulk collapse/expand-all pass `false`.
  const setItemCollapsed = useCallback(
    (path: string, collapsed: boolean, persist: boolean) => {
      const rec = itemsRef.current.get(path);
      if (rec === undefined) return;
      if (persist) {
        collapseOverridesRef.current.set(path, collapsed);
        persistCollapseOverrides(reviewId, collapseOverridesRef.current);
      }
      if (rec.item.collapsed === collapsed) return;
      rec.item.collapsed = collapsed;
      rec.item.version = (rec.item.version ?? 0) + 1;
      notifyItemMutated(rec.item);
      setItemsVersion((v) => v + 1);
    },
    [reviewId, notifyItemMutated],
  );

  const toggleFileCollapsed = useCallback(
    (path: string) => {
      const rec = itemsRef.current.get(path);
      if (rec === undefined) return;
      setItemCollapsed(path, !(rec.item.collapsed ?? false), true);
    },
    [setItemCollapsed],
  );

  const toggleViewed = useCallback(
    async (path: string) => {
      const entry = state.fileList.find((f) => f.path === path);
      if (entry === undefined) return;
      const nextViewed = !isViewed(entry);
      await setViewed(path, nextViewed);
      // Marking a file viewed collapses it out of the way; unmarking it
      // brings it back so it reads as "still needs a look" again.
      setItemCollapsed(path, nextViewed, true);
    },
    [setViewed, isViewed, state.fileList, setItemCollapsed],
  );

  const expandFileForNavigation = useCallback(
    (path: string) => {
      const rec = itemsRef.current.get(path);
      if (rec === undefined || rec.item.collapsed !== true) return;
      setItemCollapsed(path, false, false);
    },
    [setItemCollapsed],
  );

  const collapseAllFiles = useCallback(() => {
    for (const path of itemsRef.current.keys()) setItemCollapsed(path, true, false);
  }, [setItemCollapsed]);

  const expandAllFiles = useCallback(() => {
    for (const [path, rec] of itemsRef.current) {
      // Binary/over-2000-line/generated files are excluded from
      // "expand all" — unless the user has explicitly chosen to expand this
      // one, in which case that choice stands.
      const autoCollapsed = rec.entry.binary || rec.entry.generated || isLargeFile(rec.entry);
      if (autoCollapsed && !collapseOverridesRef.current.has(path)) continue;
      setItemCollapsed(path, false, false);
    }
  }, [setItemCollapsed]);

  const startDraftThread = useCallback((draft: DraftThread) => setDraftThread(draft), []);
  const cancelDraftThread = useCallback(() => {
    setDraftThread(null);
    // The gutter-utility selection lives inside CodeView's own state, not
    // ours — clear it too, or the highlighted range sticks around and blocks
    // starting a fresh comment.
    codeViewRef.current?.clearSelectedLines();
  }, []);

  const submitDraftThread = useCallback(
    async (bodyMd: string, askAgent: boolean) => {
      const draft = draftRef.current;
      if (draft === null || bodyMd.trim().length === 0) return;
      try {
        await callApi('createThread', {
          params: [reviewId],
          body: {
            path: draft.path,
            side: draft.side,
            startLine: draft.startLine,
            endLine: draft.endLine,
            bodyMd,
            askAgent,
            ...(askAgent ? { model: getAgentModel() } : {}),
          },
        });
        setDraftThread(null);
        codeViewRef.current?.clearSelectedLines();
        await reloadThreads();
      } catch {
        // Leave the draft open so the user can retry.
      }
    },
    [reviewId, reloadThreads],
  );

  const items = useMemo(() => {
    return orderRef.current
      .map((id) => itemsRef.current.get(id)?.item)
      .filter((x): x is CodeViewDiffItem<ThreadAnnotationMeta> => x !== undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsVersion, state.fileList]);

  const value: ReviewEngine = {
    ...state,
    items,
    diffStyle,
    setDiffStyle,
    leftPanelOpen,
    rightPanelOpen,
    threadsPanelOpen,
    setLeftPanelOpen,
    setRightPanelOpen,
    setThreadsPanelOpen,
    toggleLeftPanel: () => setLeftPanelOpen((v) => !v),
    toggleRightPanel: () => setRightPanelOpen((v) => !v),
    toggleThreadsPanel: () => setThreadsPanelOpen((v) => !v),
    commentsVisible,
    toggleComments: () => setCommentsVisible((v) => !v),
    selectedPath,
    setSelectedPath,
    currentStepId,
    setCurrentStepId,
    activeThreadId,
    setActiveThreadId,
    setRevision,
    setViewed,
    toggleViewed,
    isViewed,
    applyPendingRefresh,
    pendingCount:
      (state.pendingDelta?.added.length ?? 0) +
      (state.pendingDelta?.removed.length ?? 0) +
      (state.pendingDelta?.changed.length ?? 0),
    reloadThreads,
    reloadReadingOrder,
    reloadAll: load,
    generateReadingOrder,
    askAgent,
    setReaction,
    startReview,
    bumpAnnotations,
    annotationsByPath: annotationsRef.current,
    draftThread,
    startDraftThread,
    cancelDraftThread,
    submitDraftThread,
    codeViewRef,
    toggleFileCollapsed,
    expandFileForNavigation,
    collapseAllFiles,
    expandAllFiles,
  };
  // annotationsVersion is read only to satisfy the exhaustive-deps linter's
  // intent (annotationsByPath is a ref, so consumers re-render off version).
  void annotationsVersion;

  return <ReviewCtx.Provider value={value}>{children}</ReviewCtx.Provider>;
}

/**
 * The topmost visible item's id, found by comparing rendered element
 * positions against the scroll container — the DOM measurement standing in
 * for a `(path, side, line)` anchor at file granularity (line-level
 * anchoring would need hooking into Pierre's internal row layout, which
 * isn't part of the public `CodeViewHandle` surface).
 */
export function captureTopVisiblePath(
  handle: CodeViewHandle<ThreadAnnotationMeta, undefined> | null,
): string | null {
  const instance = handle?.getInstance();
  if (instance === undefined) return null;
  const container = instance.getContainerElement();
  if (container === undefined) return null;
  const containerTop = container.getBoundingClientRect().top;
  let best: { id: string; distance: number } | null = null;
  for (const rendered of instance.getRenderedItems()) {
    const rect = rendered.element.getBoundingClientRect();
    const distance = rect.top - containerTop;
    if (distance >= -4 && (best === null || distance < best.distance)) {
      best = { id: rendered.id, distance };
    }
  }
  return best?.id ?? null;
}

function nearestSurvivingPath(
  anchorPath: string,
  previousOrder: readonly string[],
  survivors: ReadonlyMap<string, ItemRecord>,
): string | null {
  const idx = previousOrder.indexOf(anchorPath);
  if (idx === -1) return null;
  for (let offset = 1; offset < previousOrder.length; offset++) {
    const after = previousOrder[idx + offset];
    if (after !== undefined && survivors.has(after)) return after;
    const before = previousOrder[idx - offset];
    if (before !== undefined && survivors.has(before)) return before;
  }
  return null;
}

/**
 * Value equality for annotation arrays — compares path-relevant fields
 * (side, lineNumber, threadId), not object identity, so the "thread list
 * changed" effect can skip paths whose derived annotations didn't actually
 * change and avoid bumping `item.version` for them.
 */
function annotationsEqual(
  a: readonly DiffLineAnnotation<ThreadAnnotationMeta>[],
  b: readonly DiffLineAnnotation<ThreadAnnotationMeta>[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.side !== y.side ||
      x.lineNumber !== y.lineNumber ||
      x.metadata?.threadId !== y.metadata?.threadId
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The POST that starts a run returns it while still `running`; the agent
 * works in the background and its `run.ended` WS event can land first when
 * it finishes quickly. Never let that stale response undo a known end.
 */
function laterRun(current: AgentRun | null, fromResponse: AgentRun): AgentRun {
  const ended = current !== null && current.id === fromResponse.id && current.endedAt !== null;
  return ended && fromResponse.endedAt === null ? current : fromResponse;
}

/** `run.delta`'s payload is `unknown` on the wire (events.ts) — read the
 * `{ text }` shape R3 promises without trusting it blindly. */
function extractDeltaText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

function isLargeFile(entry: FileEntry): boolean {
  // Over 2,000 lines or 500 KB collapses by default. Line count
  // isn't in `FileEntry`; additions+deletions is the closest proxy available
  // without fetching the patch first.
  const total = (entry.additions ?? 0) + (entry.deletions ?? 0);
  return total > 2000;
}
