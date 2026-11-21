import { X } from "lucide-react";
import { useId } from "react";
import { ReopenAction } from "./ReopenAction";
import type { Toast } from "./useHumanItems";
import { useToastLifecycle } from "./useToastLifecycle";

const PAST = {
  complete: "Completed",
  dismiss: "Dismissed",
  reopen: "Reopened",
} as const;

const DOING = {
  complete: "Completing",
  dismiss: "Dismissing",
  reopen: "Reopening",
} as const;

const UNDONE = {
  complete: "Reopened",
  dismiss: "Restored",
  reopen: "Reopened",
} as const;

/** What the toast says, in one line, for where its write and follow-up stand. */
function sentence(toast: Toast): string {
  const { action, title, phase, error, followUp } = toast;
  if (phase === "failed")
    return `Not ${PAST[action].toLowerCase()}: ${title}. ${error ?? ""}`.trim();
  const undone = UNDONE[action];
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

  // A reopen is the undo itself: nothing follows it.
  const resolving = phase !== "failed" && action !== "reopen";
  const undone = followUp?.kind === "undo" && followUp.phase === "done";
  const noteLabel = action === "dismiss" ? "Add reason" : "Add comment";
  const noteName = action === "dismiss" ? "Reason" : "Comment";
  const noting = followUp?.kind === "note" && followUp.phase === "sending";
  const undoing = followUp?.kind === "undo" && followUp.phase === "sending";
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
      {followUp?.kind === "note" && followUp.saved !== undefined && (
        <blockquote
          aria-label={`Saved ${noteName.toLowerCase()}`}
          className="human-items-toast-saved"
        >
          {followUp.saved}
        </blockquote>
      )}
      {resolving && !undone && (
        <div className="human-items-toast-actions">
          <ReopenAction
            className="human-items-toast-action"
            disabled={undoing}
            label={action === "dismiss" ? "Restore" : "Reopen"}
            onPress={onUndo}
            reopen={toast.reopen}
            sending={undoing}
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
            readOnly={noting}
            value={text}
          />
          <button
            aria-busy={noting}
            className="human-items-toast-action"
            disabled={noting}
            type="submit"
          >
            {noting
              ? "Sending…"
              : followUp?.kind === "note" && followUp.phase === "failed"
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
