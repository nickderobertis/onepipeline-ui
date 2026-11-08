import { type FocusEvent, useEffect, useRef, useState } from "react";
import type { Toast } from "./useHumanItems";

/** How long a toast stays when nothing is holding it, in milliseconds. */
export const TOAST_MS = 15_000;

/**
 * When a toast leaves, and what it holds meanwhile: the note being written, and
 * the height it reports so the list can keep that much room below its last card.
 *
 * It leaves {@link TOAST_MS} after each new state of the toast unless it is
 * hovered, focused or being written in — then once that ends — and never while a
 * follow-up is sending or after one failed, until it is sent again or closed.
 */
export function useToastLifecycle(
  toast: Toast,
  onClose: () => void,
  onRoom: (height: number) => void,
) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [expired, setExpired] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const { key, followUp } = toast;
  const persistent =
    followUp?.phase === "failed" || followUp?.phase === "sending";
  const signature = `${key}:${followUp?.kind ?? ""}:${followUp?.phase ?? ""}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the trigger — each new state of the toast is shown for the whole duration again.
  useEffect(() => {
    setExpired(false);
    if (persistent) return;
    const timer = setTimeout(() => setExpired(true), TOAST_MS);
    return () => clearTimeout(timer);
  }, [signature, persistent]);

  // A new write's toast starts with nothing typed and no editor open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger.
  useEffect(() => {
    setWriting(false);
    setText("");
  }, [key]);

  // A saved note is done with: its words are the item's now.
  useEffect(() => {
    if (followUp?.kind === "note" && followUp.phase === "done") {
      setWriting(false);
      setText("");
    }
  }, [followUp]);

  const inUse = hovered || focused || writing;
  useEffect(() => {
    if (expired && !inUse) onClose();
  }, [expired, inUse, onClose]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const report = () => onRoom(element.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onRoom(0);
    };
  }, [onRoom]);

  /** What the toast's own element listens to, to know it is being held. */
  const holds = {
    ref,
    onFocus: () => setFocused(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && event.currentTarget.contains(next)))
        setFocused(false);
    },
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
  };
  return { holds, writing, setWriting, text, setText };
}
