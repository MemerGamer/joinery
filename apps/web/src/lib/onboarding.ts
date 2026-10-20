/**
 * Whether the onboarding flow is showing, and whether it has been seen.
 *
 * It opens by itself once, on a first visit with no repositories yet (see
 * `maybeStartOnboarding`); someone who already has repos registered is
 * marked as onboarded without seeing it. Finishing or skipping marks it
 * seen; "Show onboarding" in ⌘K opens it again.
 */
import { useSyncExternalStore } from 'react';

const SEEN_KEY = 'joinery.onboarded';

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function seen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    // Locked-down storage: don't show it on every visit.
    return true;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Best-effort only.
  }
}

export function useOnboardingOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

export function openOnboarding(): void {
  open = true;
  emit();
}

/** Finished or skipped. */
export function closeOnboarding(): void {
  markSeen();
  open = false;
  emit();
}

/** Called once Homebase knows the repos: opens on a first visit to an empty Joinery. */
export function maybeStartOnboarding(repoCount: number): void {
  if (seen()) return;
  if (repoCount > 0) markSeen();
  else openOnboarding();
}
