import { useCallback, useState } from "react";

/**
 * A choice remembered per browser under `key`: what `read` makes of the stored
 * text, or `fallback` when nothing valid is stored, and every later choice
 * written back as `write` spells it.
 *
 * Storage the page may not read is no choice made, and a browser that keeps
 * nothing still holds the choice for this visit.
 */
export function useRemembered<T>(
  key: string,
  read: (stored: string) => T | undefined,
  fallback: T,
  write: (value: T) => string = String,
) {
  const [value, setHeld] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return (stored === null ? undefined : read(stored)) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const setValue = useCallback(
    (next: T) => {
      setHeld(next);
      try {
        window.localStorage.setItem(key, write(next));
      } catch {
        // Kept for this visit only.
      }
    },
    [key, write],
  );
  return [value, setValue] as const;
}
