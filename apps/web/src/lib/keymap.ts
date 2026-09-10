/**
 * The keymap (SPEC §11), declared as chords against a single modifier map so
 * a later Ctrl/Alt reading (§14, Windows) costs one table swap, not a
 * rewrite. `tinykeys`'s own `$mod` already abstracts Cmd/Ctrl; `MOD.opt` is
 * the one platform-specific piece left for us to swap.
 */
import { tinykeys } from 'tinykeys';
import { useEffect } from 'react';

const MOD = {
  primary: '$mod', // Cmd on macOS, Ctrl elsewhere — tinykeys resolves this.
  opt: 'Alt', // Opt on macOS, Alt on Windows/Linux.
} as const;

export interface KeymapActions {
  nextHunk?: () => void;
  prevHunk?: () => void;
  nextStep?: () => void;
  prevStep?: () => void;
  nextThread?: () => void;
  prevThread?: () => void;
  commentOnSelection?: () => void;
  submitComment?: () => void;
  submitCommentAskAgent?: () => void;
  resolveThread?: () => void;
  toggleLeftPanel?: () => void;
  toggleRightPanel?: () => void;
  toggleThreadsPanel?: () => void;
  toggleUnifiedSplit?: () => void;
  expandHunk?: () => void;
  expandWholeFile?: () => void;
  toggleFocusedFileCollapsed?: () => void;
  markViewed?: () => void;
  setRevisionWorking?: () => void;
  setRevisionHead?: () => void;
  setRevisionPr?: () => void;
  goHomebase?: () => void;
  goSteps?: () => void;
  openPalette?: () => void;
  showHelp?: () => void;
}

/**
 * Global keymap for the review window (SPEC §11 table). `Cmd+W/T/N/Q` are
 * deliberately absent — a browser tab can never yield them, so nothing is
 * bound there.
 */
export function useGlobalKeymap(actions: KeymapActions): void {
  useEffect(() => {
    const bind = (chord: string, fn: (() => void) | undefined) => {
      if (fn === undefined) return {};
      return { [chord]: (e: KeyboardEvent) => (e.preventDefault(), fn()) };
    };

    const unsubscribe = tinykeys(window, {
      ...bind('j', actions.nextHunk),
      ...bind('k', actions.prevHunk),
      ...bind('n', actions.nextStep),
      ...bind('p', actions.prevStep),
      ...bind(']', actions.nextThread),
      ...bind('[', actions.prevThread),
      ...bind('c', actions.commentOnSelection),
      ...bind('Enter', actions.submitComment),
      ...bind(`${MOD.primary}+Enter`, actions.submitCommentAskAgent),
      ...bind('r', actions.resolveThread),
      ...bind(`${MOD.primary}+b`, actions.toggleLeftPanel),
      ...bind(`${MOD.primary}+${MOD.opt}+b`, actions.toggleRightPanel),
      ...bind('t', actions.toggleThreadsPanel),
      ...bind('u', actions.toggleUnifiedSplit),
      ...bind('e', actions.expandHunk),
      ...bind('Shift+e', actions.expandWholeFile),
      // Not in SPEC §11's table (no key was assigned to per-file
      // collapse/expand there); `z` is free and mirrors vim's fold mnemonic.
      ...bind('z', actions.toggleFocusedFileCollapsed),
      ...bind('v', actions.markViewed),
      ...bind('1', actions.setRevisionWorking),
      ...bind('2', actions.setRevisionHead),
      ...bind('3', actions.setRevisionPr),
      ...bind('g h', actions.goHomebase),
      ...bind('g s', actions.goSteps),
      ...bind(`${MOD.primary}+k`, actions.openPalette),
      ...bind('?', actions.showHelp),
    });

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);
}
