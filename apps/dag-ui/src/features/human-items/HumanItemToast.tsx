import type { HumanItemReopen } from "@onepipeline-ui/dag-model";
import { X } from "lucide-react";
import { type FocusEvent, useEffect, useId, useRef, useState } from "react";
import type { Toast } from "./useHumanItems";

/** How long a toast stays when nothing is holding it, in milliseconds. */
export const TOAST_MS = 15_000;

const PAST = {
  answer: "Answered",
  complete: "Completed",
  dismiss: "Dismissed",
} as const;

const UNDONE = { complete: "Reopened", dismiss: "Restored" } as const;

/** What the toast says, in one line, for where its write and follow-up stand. */
function sentence(toast: Toast): string {
  const { action, title, phase, error, followUp } = toast;
  if (phase === "failed")
    return `Not ${PAST[action].toLowerCase()}: ${title}. ${error ?? ""}`.trim();
  const undone = action === "answer" ? "Reopened" : UNDONE[action];
  const noted = action === "dismiss" ? "Reason" : "Comment";
  if (followUp?.phase === "failed")
    return followUp.kind === "undo"
      ? `Not ${undone.toLowerCase()}: ${title}. ${followUp.error ?? ""}`.trim()
      : `${noted} not saved: ${title}. ${followUp.error ?? ""}`.trim();
  if (followUp?.phase === "done")
    return followUp.kind === "undo"
      ? `${undone}: ${title}`
      : `${noted} saved: ${title}`;
  return `${PAST[action]}: ${title}`;
}

/**
 * The last write's toast: muted green once it went through, muted red when it or
 * what followed it failed. It leaves after {@link TOAST_MS} unless it is hovered,
 * focused or being written in — then it leaves once that ends — and a failed
 * follow-up keeps it, with the reason and whatever was typed, until it is sent
 * again or closed. Its height is reported, so the list can keep that much room
 * below its last card.
 */
export function HumanItemToast({
  toast,
  onUndo,
  onNote,
  onClose,
  onRoom,
}: {
  readonly toast: Toast;
  readonly onUndo: () => void;
  readonly onNote: (text: string) => void;
  readonly onClose: () => void;
  /** The toast's height in CSS pixels, or 0 once it is gone. */
  readonly onRoom: (height: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [expired, setExpired] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const noteId = useId();
  const { key, action, phase, followUp } = toast;
  const failed = phase === "failed" || followUp?.phase === "failed";
  // A failed follow-up stays until it is sent again or closed.
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

  const leaving = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      setFocused(false);
  };

  const resolving = action !== "answer" && phase !== "failed";
  const undone = followUp?.kind === "undo" && followUp.phase === "done";
  const noteLabel = action === "dismiss" ? "Add reason" : "Add comment";
  const noteName = action === "dismiss" ? "Reason" : "Comment";
  return (
    <section
      aria-label="Action result"
      className="human-items-toast"
      data-tone={failed ? "failure" : "success"}
      onBlur={leaving}
      onFocus={() => setFocused(true)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      ref={ref}
    >
      <p
        className="human-items-toast-message"
        role={failed ? "alert" : "status"}
      >
        {sentence(toast)}
      </p>
      {resolving && !undone && (
        <div className="human-items-toast-actions">
          <UndoAction
            label={action === "dismiss" ? "Restore" : "Reopen"}
            onPress={onUndo}
            reopen={toast.reopen}
            sending={followUp?.kind === "undo" && followUp.phase === "sending"}
          />
          {!writing && (
            <button
              className="human-items-toast-action"
              onClick={() => setWriting(true)}
              type="button"
            >
              {noteLabel}
            </button>
          )}
        </div>
      )}
      {resolving && !undone && writing && (
        <form
          className="human-items-toast-note"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() !== "") onNote(text);
          }}
        >
          <label className="sr-only" htmlFor={noteId}>
            {noteName}
          </label>
          <input
            // biome-ignore lint/a11y/noAutofocus: the reader just asked to write here; the field is where their next keystroke belongs.
            autoFocus
            id={noteId}
            onChange={(event) => setText(event.target.value)}
            placeholder={`${noteName}, then Enter`}
            readOnly={followUp?.kind === "note" && followUp.phase === "sending"}
            value={text}
          />
          <button className="human-items-toast-action" type="submit">
            {followUp?.kind === "note" && followUp.phase === "failed"
              ? "Send again"
              : "Send"}
          </button>
        </form>
      )}
      <button
        aria-label="Close"
        className="human-items-toast-close"
        onClick={onClose}
        type="button"
      >
        <X aria-hidden="true" size={14} />
      </button>
    </section>
  );
}

/**
 * Restore or Reopen. Where the engine says it cannot be, it is greyed, and a
 * small question mark set on its text as a superscript gives the reason — on
 * hover, and on a press, which is the one a phone has. The mark is a control of
 * its own beside the greyed one, never inside a disabled one, so it stays
 * pressable.
 */
function UndoAction({
  label,
  reopen,
  sending,
  onPress,
}: {
  readonly label: string;
  readonly reopen?: HumanItemReopen;
  readonly sending: boolean;
  readonly onPress: () => void;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const tip = useId();
  if (reopen?.available !== false)
    return (
      <button
        aria-busy={sending}
        className="human-items-toast-action"
        onClick={() => {
          if (!sending) onPress();
        }}
        type="button"
      >
        {sending ? `${label}…` : label}
      </button>
    );
  return (
    <span
      className="human-items-toast-action human-items-unavailable"
      data-unavailable-action={label}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button aria-describedby={tip} disabled type="button">
        {label}
      </button>
      <sup className="human-items-why-anchor">
        <button
          aria-controls={tip}
          aria-expanded={pinned}
          aria-label={`Why ${label} is unavailable`}
          className="human-items-why"
          onClick={() => setPinned((open) => !open)}
          type="button"
        >
          ?
        </button>
      </sup>
      <span
        className="human-items-why-tip"
        hidden={!(pinned || hovered)}
        id={tip}
        role="tooltip"
      >
        {reopen.reason}
      </span>
    </span>
  );
}
