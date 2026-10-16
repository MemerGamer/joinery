/**
 * Minimal hash router — the surfaces are Homebase (`#/`, with Explore as
 * its last section), a review window (`#/reviews/:id`) and the settings page
 * (`#/settings`). No dependency pulled in for three routes.
 */
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'homebase' }
  | { name: 'review'; reviewId: string }
  | { name: 'settings' };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const match = /^\/reviews\/([^/]+)/.exec(path);
  if (match?.[1] !== undefined) return { name: 'review', reviewId: decodeURIComponent(match[1]) };
  if (/^\/settings\/?$/.test(path)) return { name: 'settings' };
  return { name: 'homebase' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    // Route changes swap instantly — no transition between screens.
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function goHomebase(): void {
  location.hash = '#/';
}

/** DOM id of the Explore section on Homebase. */
export const EXPLORE_ID = 'explore';

/** Scrolls Homebase down to its Explore section and focuses the search field. */
export function goExplore(): void {
  const section = document.getElementById(EXPLORE_ID);
  section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  section?.querySelector('input')?.focus({ preventScroll: true });
}

export function goSettings(): void {
  location.hash = '#/settings';
}

export function goReview(reviewId: string): void {
  location.hash = `#/reviews/${encodeURIComponent(reviewId)}`;
}
