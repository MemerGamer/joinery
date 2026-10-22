/**
 * Pieces shared by the diff's code intelligence (components/CodeIntel.tsx)
 * and its peek window (components/PeekNavigator.tsx).
 */

const CACHE_LIMIT = 2_000;

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const PEEK_KEY = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Injected into each file's shadow root alongside the card CSS: the token
 * under the pointer reads as a link while the peek modifier is held.
 */
export const CODE_INTEL_CSS = `
[data-char][data-lsp-link] {
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
`;

/** Shared by every waiter; a request that fails or is aborted is dropped so the next hover asks again. */
export function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return promise;
}

/** Below the anchor when it fits, otherwise above; always inside the viewport. */
export function placement(rect: DOMRect, width: number, height: number): React.CSSProperties {
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.left - 12, window.innerWidth - width - margin));
  const below = rect.bottom + 6;
  if (below + height <= window.innerHeight - margin || rect.top - 6 - height < margin) {
    return { left, top: below, maxHeight: Math.max(120, window.innerHeight - below - margin) };
  }
  return { left, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(120, rect.top - 6 - margin) };
}
