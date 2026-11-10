import { TaskMarkdown } from "@onetaskgraph/ui";
import { useEffect, useRef } from "react";
import type { NotSent } from "./human-item-drafts";

/** What the send bar shows and does; see {@link useAnswerDrafts}. */
interface SendBarAnswers {
  readonly count: number;
  readonly remaining: number;
  readonly sending: boolean;
  readonly sendError: string | undefined;
  readonly notices: readonly NotSent[];
  readonly send: () => Promise<void>;
  readonly discard: () => void;
  readonly clearNotice: (key: number) => void;
}

/**
 * A fixed region under the list and the detail, present while anything is
 * drafted or was not sent, so an answer can go out with a detail still open. It
 * reports its height so a toast sits clear above it.
 */
export function SendBar({
  answers,
  onRoom,
}: {
  readonly answers: SendBarAnswers;
  readonly onRoom: (height: number) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const { count, remaining, sending, sendError, notices } = answers;
  const shown = count > 0 || sendError !== undefined || notices.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` is the trigger — the region only exists once it is true, so that is when there is something to measure.
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
  }, [onRoom, shown]);
  if (!shown) return null;
  return (
    <section
      aria-label="Drafted answers"
      className="human-items-send"
      ref={ref}
    >
      {count > 0 && (
        <div className="human-items-send-bar">
          <button
            className="human-items-send-action"
            data-primary="true"
            disabled={sending}
            onClick={() => void answers.send()}
            type="button"
          >
            {sending
              ? "Sending…"
              : `Send ${count} ${count === 1 ? "answer" : "answers"}`}
          </button>
          <button
            className="human-items-send-action"
            disabled={sending}
            onClick={answers.discard}
            type="button"
          >
            Discard
          </button>
          {remaining > 0 && (
            <span className="human-items-send-more">
              {remaining} more after this
            </span>
          )}
        </div>
      )}
      {sendError !== undefined && (
        <p className="human-item-status" data-failed="true" role="alert">
          Not sent, and your drafts are kept: {sendError}
        </p>
      )}
      {notices.length > 0 && (
        <ul aria-label="Not sent" className="human-items-not-sent">
          {notices.map((notice) => (
            <li key={notice.key}>
              <p>
                <strong>Not sent: {notice.title}</strong> ({notice.reason})
              </p>
              {notice.choiceTitle !== undefined && (
                <p>Choice: {notice.choiceTitle}</p>
              )}
              {notice.text !== undefined && (
                <TaskMarkdown source={notice.text} />
              )}
              <button
                className="human-items-send-action"
                onClick={() => answers.clearNotice(notice.key)}
                type="button"
              >
                Clear
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
