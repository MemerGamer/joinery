/**
 * Turning a bare name (PR author login, commit author, `git config
 * user.name`) into something the UI can render an avatar and a first-person
 * greeting from — with no server-side "people" concept to lean on.
 */
import type { CiStatus, Me } from '@review/core';

export interface Person {
  name: string;
  initials: string;
  /** Hue for the avatar tint; the CSS derives light/dark colours from it. */
  hue: number;
  /** Agents get a robot glyph instead of initials. */
  agent?: boolean;
}

/** Server `CiStatus` widened with "no checks at all". */
export type Ci = CiStatus | null;

const AGENT_NAME_RE = /claude|copilot|\[bot\]|-bot$/i;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    return (words[0] ?? '').slice(0, 2).toUpperCase();
  }
  const first = words[0]?.[0] ?? '';
  const second = words[1]?.[0] ?? '';
  return `${first}${second}`.toUpperCase();
}

export function personFrom(name: string | null | undefined): Person {
  const trimmed = name?.trim() ?? '';
  if (trimmed.length === 0) {
    return { name: 'Unknown', initials: '?', hue: 0 };
  }
  const base: Person = {
    name: trimmed,
    initials: initialsOf(trimmed),
    hue: hashString(trimmed) % 360,
  };
  return AGENT_NAME_RE.test(trimmed) ? { ...base, agent: true } : base;
}

/** First word of the person's name, or "you" when it's the local user. */
export function firstName(p: Person, you: string | null): string {
  if (you !== null && you.trim().length > 0 && p.name.toLowerCase() === you.trim().toLowerCase()) {
    return 'you';
  }
  return p.name.split(/\s+/)[0] ?? p.name;
}

/** Whether `name` refers to the local user, by either their display name or login. */
export function isYou(name: string | null, me: Me | null): boolean {
  if (name === null || me === null) return false;
  const lower = name.toLowerCase();
  if (me.name !== null && me.name.toLowerCase() === lower) return true;
  return me.login !== null && me.login.toLowerCase() === lower;
}
