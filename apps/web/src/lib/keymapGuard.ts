/**
 * Bug 2 fix (keymap audit, 2026-09-11): single-key (unmodified) global
 * shortcuts — `j k n p ] [ c r t u e z v 1 2 3 Enter ?` — must not fire
 * while the user is typing into a text field, a contenteditable region, or
 * an open dialog/palette (the command palette is a `cmdk` `Command.Dialog`,
 * which renders `role="dialog"`). `$mod` (Cmd/Ctrl) chords must keep firing
 * there regardless — most importantly `$mod+Enter` ("submit and ask agent")
 * from inside the comment composer.
 *
 * Kept as pure, DOM-shape-typed functions (not `Element`/`HTMLElement`) so
 * they're testable with plain mock objects — `apps/web` has no jsdom/happy-dom
 * test environment wired up, so a real DOM isn't available under `bun test`.
 */

/**
 * The minimal structural shape we need from an event target. Deliberately
 * not `Element` — keeps this testable with plain object literals.
 */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?(selector: string): TargetLike | null;
}

const EDITABLE_TAG_NAMES = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Resolves the real originating element for a keyboard event, piercing
 * shadow DOM. The diff view (`@pierre/diffs`) renders into shadow DOM, so
 * `event.target` alone can be the shadow host rather than the actually
 * focused element inside it — `event.composedPath()[0]` gives the true
 * innermost target.
 */
export function resolveEventTarget(
  event: Pick<KeyboardEvent, 'composedPath' | 'target'>,
): EventTarget | null {
  const [innermost] = event.composedPath();
  return innermost ?? event.target;
}

/**
 * True if `target` is a text-entry control, a contenteditable region, or
 * sits inside an open dialog/palette.
 */
export function isEditableTarget(target: TargetLike | EventTarget | null | undefined): boolean {
  const el = target as TargetLike | null | undefined;
  if (el == null) return false;

  if (typeof el.tagName === 'string' && EDITABLE_TAG_NAMES.has(el.tagName.toUpperCase())) {
    return true;
  }
  if (el.isContentEditable === true) return true;

  if (typeof el.closest === 'function') {
    if (el.closest('[contenteditable="true"], [contenteditable=""]') !== null) return true;
    if (el.closest('[role="dialog"]') !== null) return true;
  }

  return false;
}

/**
 * `tinykeys`'s `ignore` predicate: whether a keydown should be skipped
 * entirely before any binding is matched against it.
 *
 * - Repeats and IME composition keystrokes are always ignored (mirrors
 *   `tinykeys`'s own default).
 * - A `$mod` (Cmd/Ctrl) chord always fires, even while typing.
 * - Everything else — plain letters, `Shift+letter`, `Alt` chords — is
 *   suppressed when it originates from an editable target.
 */
export function shouldIgnoreGlobalShortcut(event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing) return true;
  if (event.metaKey || event.ctrlKey) return false;
  return isEditableTarget(resolveEventTarget(event));
}
