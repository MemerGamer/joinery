import { describe, expect, it } from 'bun:test';
import {
  isEditableTarget,
  resolveEventTarget,
  shouldIgnoreGlobalShortcut,
  type TargetLike,
} from '../src/lib/keymapGuard.ts';

function target(overrides: Partial<TargetLike> = {}): TargetLike {
  return {
    closest: () => null,
    ...overrides,
  };
}

function keyEvent(overrides: Partial<KeyboardEvent> & { target?: TargetLike; composedPathTarget?: TargetLike }): KeyboardEvent {
  const composedPathTarget = overrides.composedPathTarget;
  const base = {
    repeat: false,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: overrides.target ?? null,
    composedPath: () => (composedPathTarget !== undefined ? [composedPathTarget as unknown as EventTarget] : []),
  };
  return { ...base, ...overrides } as unknown as KeyboardEvent;
}

describe('resolveEventTarget', () => {
  it('prefers the innermost element from composedPath (pierces shadow DOM)', () => {
    const shadowHost = target({ tagName: 'DIV' });
    const innerInput = target({ tagName: 'TEXTAREA' });
    const event = {
      target: shadowHost as unknown as EventTarget,
      composedPath: () => [innerInput as unknown as EventTarget, shadowHost as unknown as EventTarget],
    };
    expect(resolveEventTarget(event)).toBe(innerInput as unknown as EventTarget);
  });

  it('falls back to event.target when composedPath is empty', () => {
    const el = target({ tagName: 'DIV' });
    const event = { target: el as unknown as EventTarget, composedPath: () => [] };
    expect(resolveEventTarget(event)).toBe(el as unknown as EventTarget);
  });
});

describe('isEditableTarget', () => {
  it('is false for null/undefined', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });

  it('is true for input/textarea/select tags', () => {
    expect(isEditableTarget(target({ tagName: 'INPUT' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'SELECT' }))).toBe(true);
  });

  it('is case-insensitive on tag name', () => {
    expect(isEditableTarget(target({ tagName: 'input' }))).toBe(true);
  });

  it('is false for a plain div', () => {
    expect(isEditableTarget(target({ tagName: 'DIV' }))).toBe(false);
  });

  it('is true when isContentEditable is set', () => {
    expect(isEditableTarget(target({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  it('is true when nested inside a contenteditable ancestor', () => {
    const el = target({
      tagName: 'SPAN',
      closest: (sel) => (sel.includes('contenteditable') ? target({ tagName: 'DIV' }) : null),
    });
    expect(isEditableTarget(el)).toBe(true);
  });

  it('is true when nested inside an open dialog (e.g. the command palette)', () => {
    const el = target({
      tagName: 'SPAN',
      closest: (sel) => (sel.includes('role="dialog"') ? target({ tagName: 'DIV' }) : null),
    });
    expect(isEditableTarget(el)).toBe(true);
  });
});

describe('shouldIgnoreGlobalShortcut', () => {
  it('ignores repeated keydowns', () => {
    const event = keyEvent({ repeat: true, target: target({ tagName: 'BODY' }) });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(true);
  });

  it('ignores keydowns during IME composition', () => {
    const event = keyEvent({ isComposing: true, target: target({ tagName: 'BODY' }) });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(true);
  });

  it('does not ignore a plain letter outside an editable target', () => {
    const event = keyEvent({ target: target({ tagName: 'BODY' }) });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(false);
  });

  it('ignores a plain letter typed into a textarea (Bug 2)', () => {
    const event = keyEvent({ target: target({ tagName: 'TEXTAREA' }) });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(true);
  });

  it('ignores Enter typed into an input', () => {
    const event = keyEvent({ target: target({ tagName: 'INPUT' }) });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(true);
  });

  it('does NOT ignore a $mod chord even inside a textarea (Cmd+Enter must submit)', () => {
    const event = keyEvent({ metaKey: true, target: target({ tagName: 'TEXTAREA' }) });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(false);
  });

  it('does NOT ignore a Ctrl chord inside a textarea either', () => {
    const event = keyEvent({ ctrlKey: true, target: target({ tagName: 'TEXTAREA' }) });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(false);
  });

  it('ignores plain keys while the shadow-DOM-resolved target is editable', () => {
    const shadowHost = target({ tagName: 'DIV' });
    const innerTextarea = target({ tagName: 'TEXTAREA' });
    const event = keyEvent({ target: shadowHost, composedPathTarget: innerTextarea });
    expect(shouldIgnoreGlobalShortcut(event)).toBe(true);
  });
});
