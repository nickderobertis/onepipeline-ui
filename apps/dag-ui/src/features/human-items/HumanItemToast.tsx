import type { HumanItemReopen } from "@onepipeline-ui/dag-model";
import { X } from "lucide-react";
import { useId, useState } from "react";
import type { Toast } from "./useHumanItems";
import { useToastLifecycle } from "./useToastLifecycle";

const PAST = {
  answer: "Answered",
  complete: "Completed",
  dismiss: "Dismissed",
} as const;

const DOING = {
  answer: "Answering",
  complete: "Completing",
  dismiss: "Dismissing",
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
  return phase === "sending"
    ? `${DOING[action]}: ${title}…`
    : `${PAST[action]}: ${title}`;
}

/**
 * The last write's toast: muted green once it went through, muted red when it or
 * what followed it failed. When it leaves, and what it holds meanwhile, is
 * {@link useToastLifecycle}'s.
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
  const { holds, writing, setWriting, text, setText } = useToastLifecycle(
    toast,
    onClose,
    onRoom,
  );
  const noteId = useId();
  const { action, phase, followUp } = toast;
  const failed = phase === "failed" || followUp?.phase === "failed";

  const resolving = action !== "answer" && phase !== "failed";
  const undone = followUp?.kind === "undo" && followUp.phase === "done";
  const noteLabel = action === "dismiss" ? "Add reason" : "Add comment";
  const noteName = action === "dismiss" ? "Reason" : "Comment";
  return (
    <section
      aria-label="Action result"
      className="human-items-toast"
      data-phase={followUp?.phase ?? phase}
      data-tone={failed ? "failure" : "success"}
      {...holds}
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
      aria-label={`${label} (unavailable)`}
      className="human-items-toast-action human-items-unavailable"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      role="group"
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
