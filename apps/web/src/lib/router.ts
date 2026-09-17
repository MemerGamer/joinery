/**
 * Minimal hash router — the three surfaces are Homebase (`#/`), Explore
 * (`#/explore`), and a review window (`#/reviews/:id`). No dependency pulled
 * in for three routes.
 */
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

export type Route =
  | { name: 'homebase' }
  | { name: 'explore' }
  | { name: 'review'; reviewId: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const match = /^\/reviews\/([^/]+)/.exec(path);
  if (match?.[1] !== undefined) return { name: 'review', reviewId: decodeURIComponent(match[1]) };
  if (path.startsWith('/explore')) return { name: 'explore' };
  return { name: 'homebase' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    // Route changes go through the View Transitions API where it exists:
    // the browser snapshots the old screen, we swap the route synchronously
    // inside the callback (flushSync, so React commits before the snapshot
    // of the new screen), and the CSS in index.css animates between them.
    const onChange = () => {
      const next = parseHash(location.hash);
      if (typeof document.startViewTransition !== 'function') {
        setRoute(next);
        return;
      }
      document.startViewTransition(() => {
        flushSync(() => setRoute(next));
      });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function goHomebase(): void {
  location.hash = '#/';
}

export function goExplore(): void {
  location.hash = '#/explore';
}

export function goReview(reviewId: string): void {
  location.hash = `#/reviews/${encodeURIComponent(reviewId)}`;
}
