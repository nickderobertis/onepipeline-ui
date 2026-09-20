import { useEffect, useState } from "react";

export interface Read<T> {
  readonly value?: T;
  readonly error?: Error;
  /** Whether a read is out and nothing has been read yet. */
  readonly loading: boolean;
}

/**
 * One read of a wrapped verb, taken when its key changes and again whenever
 * the stream says something moved.
 *
 * A value already on screen stays while a re-read is out or fails: a status
 * that flickers to a skeleton on every invalidation is unreadable on a run that
 * is moving. A different key never shows the previous key's value — the key is
 * part of what the value is a reading of.
 */
export function useRead<T>(
  key: string | undefined,
  read: () => Promise<T>,
  invalidations: number,
): Read<T> {
  const [state, setState] = useState<{
    readonly key?: string;
    readonly value?: T;
    readonly error?: Error;
  }>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is a closure over the key and the client — the key is what says it changed, and `invalidations` is what asks for the same read again; listing the closure would re-read on every render.
  useEffect(() => {
    if (key === undefined) return;
    let current = true;
    read()
      .then((value) => {
        if (current) setState({ key, value });
      })
      .catch((caught: unknown) => {
        if (current)
          setState((previous) => ({
            ...(previous.key === key ? previous : {}),
            key,
            error: asError(caught),
          }));
      });
    return () => {
      current = false;
    };
  }, [key, invalidations]);
  const shown = state.key === key ? state : undefined;
  return {
    value: shown?.value,
    error: shown?.error,
    loading:
      key !== undefined &&
      shown?.value === undefined &&
      shown?.error === undefined,
  };
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
