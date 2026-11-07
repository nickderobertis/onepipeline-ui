import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateSetting } from "./update-settings";

/**
 * One area's copy of what the tab's stream delivers, taken as its setting says.
 *
 * What is held is the latest whole value rather than a queue of what led to it,
 * because the stream is applied upstream as it arrives: however long the hold,
 * this keeps one value and one count. A timer here only decides when that value
 * is shown, and asks the server for nothing.
 *
 * `apply` shows a value.
 */
export function useHeldArea<T>(
  setting: UpdateSetting,
  apply: (value: T) => void,
) {
  const [waiting, setWaiting] = useState(0);
  const held = useRef<{ readonly value: T } | undefined>(undefined);
  const applied = useRef(apply);
  applied.current = apply;
  const asItArrives = setting === "live";
  const passing = useRef(asItArrives);
  passing.current = asItArrives;

  /** Show `value` now, in place of anything held. */
  const show = useCallback((value: T) => {
    held.current = undefined;
    setWaiting(0);
    applied.current(value);
  }, []);

  /** Show what is held, if anything is. */
  const take = useCallback(() => {
    if (held.current !== undefined) show(held.current.value);
  }, [show]);

  /** A value `changes` changes on from the last, shown as the setting says. */
  const offer = useCallback(
    (value: T, changes = 1) => {
      if (passing.current) show(value);
      else {
        held.current = { value };
        setWaiting((count) => count + changes);
      }
    },
    [show],
  );

  /** Forget what is held: it was about something no longer on screen. */
  const drop = useCallback(() => {
    held.current = undefined;
    setWaiting(0);
  }, []);

  useEffect(() => {
    if (asItArrives) take();
  }, [asItArrives, take]);

  useEffect(() => {
    if (typeof setting !== "number") return;
    const ticking = setInterval(take, setting * 1000);
    return () => clearInterval(ticking);
  }, [setting, take]);

  return { waiting, show, take, offer, drop };
}
