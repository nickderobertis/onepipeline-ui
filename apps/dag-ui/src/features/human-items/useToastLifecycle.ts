import { type FocusEvent, useEffect, useRef, useState } from "react";
import type { Toast } from "./useHumanItems";

/** How long a toast stays when nothing is holding it, in milliseconds. */
export const TOAST_MS = 15_000;

/**
 * When a toast leaves, and what it holds meanwhile: the note being written, and
 * the height it reports so the list can keep that much room below its last card.
 *
 * It leaves {@link TOAST_MS} after each new state of the toast — shown, its
 * receipt or refusal in, a follow-up settled — unless it is
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
  const { key, phase, followUp } = toast;
  const persistent =
    followUp?.phase === "failed" || followUp?.phase === "sending";
  // Each new state — the receipt or refusal landing, a follow-up settling — is
  // shown for the whole duration, however long the receipt took.
  const signature = `${key}:${phase}:${followUp?.kind ?? ""}:${followUp?.phase ?? ""}`;

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

  useEffect(() => {
    if (!expired || hovered || writing) return;
    // Focus is asked of the document as well as remembered: a control removed
    // while focused — the note's field, once it is sent — fires no blur, and
    // would otherwise hold the toast for good.
    const holding = ref.current?.contains(document.activeElement) ?? false;
    if (focused && holding) return;
    onClose();
  }, [expired, hovered, focused, writing, onClose]);

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
