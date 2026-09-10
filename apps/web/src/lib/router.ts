/**
 * Minimal hash router — the two surfaces are Homebase (`#/`) and a review
 * window (`#/reviews/:id`). No dependency pulled in for two routes.
 */
import { useEffect, useState } from 'react';

export type Route = { name: 'homebase' } | { name: 'review'; reviewId: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const match = /^\/reviews\/([^/]+)/.exec(path);
  if (match?.[1] !== undefined) return { name: 'review', reviewId: decodeURIComponent(match[1]) };
  return { name: 'homebase' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function goHomebase(): void {
  location.hash = '#/';
}

export function goReview(reviewId: string): void {
  location.hash = `#/reviews/${encodeURIComponent(reviewId)}`;
}
