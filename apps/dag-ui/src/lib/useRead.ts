import { useEffect, useRef, useState } from "react";

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
 *
 * **One read of a key is out at a time**, on the terms `useDagTelemetry` keeps
 * for the run's detail: an invalidation that arrives while a read is out is
 * remembered rather than obeyed, and obeyed once that read lands. A read is
 * never discarded for being overtaken — on a run that is moving the stream can
 * ask faster than a slow verb answers, and a read cancelled on every ask never
 * lands — and never doubled, because a verb that takes seconds asked for twice
 * a second is a browser out of connections for every other read. Only a read
 * for a key no longer on screen is ignored.
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
  /**
   * Which key is on screen, the read out for it, and whether something asked
   * for it again while that read was out.
   */
  const reads = useRef<{
    key?: string;
    out?: { readonly key: string; again: boolean };
  }>({ key });
  useEffect(() => {
    reads.current.key = key;
  }, [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is a closure over the key and the client — the key is what says it changed, and `invalidations` is what asks for the same read again; listing the closure would re-read on every render.
  useEffect(() => {
    if (key === undefined) return;
    const out = reads.current.out;
    if (out?.key === key) {
      out.again = true;
      return;
    }
    const take = () => {
      const mine = { key, again: false };
      reads.current.out = mine;
      const landed = (settle: () => void) => {
        if (reads.current.out === mine) reads.current.out = undefined;
        if (reads.current.key !== key) return;
        settle();
        if (mine.again) take();
      };
      read()
        .then((value) => landed(() => setState({ key, value })))
        .catch((caught: unknown) =>
          landed(() =>
            setState((previous) => ({
              ...(previous.key === key ? previous : {}),
              key,
              error: asError(caught),
            })),
          ),
        );
    };
    take();
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
