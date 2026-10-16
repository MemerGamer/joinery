import { useEffect, useState } from 'react';

/** State remembered across visits as JSON in localStorage, e.g. a list's filters and sort. */
export function useStoredState<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Best-effort only — private/locked-down storage just won't persist.
    }
  }, [key, value]);
  return [value, setValue];
}
