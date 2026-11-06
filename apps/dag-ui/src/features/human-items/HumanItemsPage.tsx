import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@oneharness/ui";
import type { HumanItemDetail, HumanItemView } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { ExternalLink, X } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";
import {
  BLOCKING_CHOICES,
  blockedGroups,
  blockedPhrases,
  blockedSummary,
  type FilterChoice,
  isBlocking,
  KIND_CHOICES,
  kindLabel,
  NO_FILTER,
  oneOf,
  PRIORITY_CHOICES,
  PRIORITY_OPTIONS,
  priorityLabel,
  SOURCE_CHOICES,
  STATE_CHOICES,
  STATE_OPTIONS,
  sourceWords,
  stateLabel,
  toFilter,
  trackerProvider,
} from "./human-items-model";
import { TaskMarkdown } from "../../spike/TaskMarkdown";
import {
  type HumanItemWrite,
  useHumanItems,
  type WriteState,
} from "./useHumanItems";

/** Marks every card control that belongs to the card-action focus group. */
const CARD_ACTION = "data-card-action";

type Write = (view: HumanItemView, change: HumanItemWrite) => void;

/**
 * The host-wide action items: tasks and questions the operator's attention is
 * asked for, most urgent first, with the open questions answerable in place.
 *
 * Keyboard: Tab moves from one open question's answer box straight to the next,
 * and nothing else on a card is in that sequence. After the last answer box
 * comes the card-action group — tracker links, Details, Complete and Dismiss —
 * which the arrow keys move through; Enter follows a focused link, and Enter
 * or Space presses a focused button.
 */
export function HumanItemsPage({
  client,
  refresh,
}: {
  readonly client: TelemetryClient;
  /** Counts the header's Refresh presses; each one reads the list again. */
  readonly refresh: number;
}) {
  const [choice, setChoice] = useState<FilterChoice>(NO_FILTER);
  const [selectedId, setSelectedId] = useState<string>();
  const [dismissing, setDismissing] = useState<HumanItemView>();
  const filter = useMemo(() => toFilter(choice), [choice]);
  const items = useHumanItems(client, filter, selectedId, refresh);
  const listRef = useRef<HTMLUListElement>(null);
  const selected =
    items.items?.find(({ item }) => item.id === selectedId) ??
    (items.detail === undefined ? undefined : items.detail);

  // SPIKE: writes are faked locally, a card leaves at once and a toast answers.
  const [groupBy, setGroupBy] = useState("priority");
  const [gone, setGone] = useState<readonly string[]>([]);
  const [toast, setToast] = useState<Toast>();
  const [failed, setFailed] = useState<string>();
  const ask = (view: HumanItemView, change: HumanItemWrite) => {
    if (change.action === "answer") return items.write(view, change);
    setSelectedId(undefined);
    const action = change.action;
    if (view.item.id === "item-refused") {
      setFailed(view.item.id);
      setToast({ action, view, refused: REFUSAL });
    } else {
      setGone((all) => [...all, view.item.id]);
      setToast({ action, view });
    }
  };
  const shown = (items.items ?? []).filter(
    ({ item }) => !gone.includes(item.id),
  );

  return (
    <section
      aria-label="Action items"
      className="human-items-page"
      data-detail-open={selectedId !== undefined}
    >
      <Filters
        choice={choice}
        groupBy={groupBy}
        onChange={setChoice}
        onGroupBy={setGroupBy}
      />
      {items.outcome && (
        <p
          aria-label="Last outcome"
          className="human-items-outcome"
          data-failed={items.outcome.failed}
          role="status"
        >
          {items.outcome.title}: {items.outcome.message}
        </p>
      )}
      <div className="human-items-body">
        <section aria-label="Action item list" className="human-items-list">
          {items.listError && <p role="alert">{items.listError}</p>}
          {items.items === undefined && !items.listError && (
            <p role="status">Reading action items…</p>
          )}
          {items.items?.length === 0 && (
            <p role="status">No action items match these filters.</p>
          )}
          <div
            onKeyDown={(event) =>
              roveCardActions(
                event as unknown as KeyboardEvent<HTMLUListElement>,
                listRef.current as HTMLUListElement | null,
              )
            }
            ref={listRef as unknown as React.RefObject<HTMLDivElement>}
          >
            {spikeGroups(shown, groupBy).map(({ heading, views }) => (
              <section className="spike-group" key={heading}>
                {heading !== "" && (
                  <h3>
                    {heading} <span>{views.length}</span>
                  </h3>
                )}
                <ul aria-label={heading || "Action items"}>
                  {views.map((view) => (
                    <li key={view.item.id}>
                      <HumanItemCard
                        draft={items.drafts[view.item.id] ?? ""}
                        onDraft={(text) => items.setDraft(view.item.id, text)}
                        onSelect={() => setSelectedId(view.item.id)}
                        onWrite={ask}
                        refusal={failed === view.item.id ? REFUSAL : undefined}
                        selected={view.item.id === selectedId}
                        state={items.writes[view.item.id]}
                        view={view}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {(items.items?.length ?? 0) > 0 && (
            <button
              className="card-actions-entry"
              onFocus={() =>
                listRef.current
                  ?.querySelector<HTMLElement>(`[${CARD_ACTION}]`)
                  ?.focus()
              }
              type="button"
            >
              Card actions: use the arrow keys
            </button>
          )}
        </section>
        {selectedId !== undefined && (
          <DetailPane
            draft={items.drafts[selectedId] ?? ""}
            error={items.detailError}
            detail={items.detail}
            onClose={() => setSelectedId(undefined)}
            onDraft={(text) => items.setDraft(selectedId, text)}
            onWrite={ask}
            state={items.writes[selectedId]}
            view={selected}
          />
        )}
      </div>
      {toast && (
        <SpikeToast onClose={() => setToast(undefined)} toast={toast} />
      )}
      <DismissDialog
        onCancel={() => setDismissing(undefined)}
        onConfirm={(reason) => {
          if (dismissing)
            items.write(dismissing, { action: "dismiss", reason });
          setDismissing(undefined);
        }}
        view={dismissing}
      />
    </section>
  );
}

/** Arrow keys, Home and End move focus through every card action in the list. */
function roveCardActions(
  event: KeyboardEvent<HTMLUListElement>,
  list: HTMLUListElement | null,
) {
  const target = event.target;
  if (list === null || !(target instanceof HTMLElement)) return;
  if (!target.hasAttribute(CARD_ACTION)) return;
  const actions = [...list.querySelectorAll<HTMLElement>(`[${CARD_ACTION}]`)];
  const at = actions.indexOf(target);
  const next =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? actions[Math.min(at + 1, actions.length - 1)]
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? actions[Math.max(at - 1, 0)]
        : event.key === "Home"
          ? actions[0]
          : event.key === "End"
            ? actions.at(-1)
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

function Filters({
  choice,
  onChange,
  groupBy,
  onGroupBy,
}: {
  readonly choice: FilterChoice;
  readonly onChange: (choice: FilterChoice) => void;
  readonly groupBy: string;
  readonly onGroupBy: (field: string) => void;
}) {
  const id = useId();
  const set = <K extends keyof FilterChoice>(key: K, value: FilterChoice[K]) =>
    onChange({ ...choice, [key]: value });
  const named = choice.source !== "" && choice.source !== "host";
  return (
    <fieldset className="human-items-filters">
      <legend className="sr-only">Filter action items</legend>
      <label className="spike-groupby" htmlFor={`${id}-group`}>
        Group by
      </label>
      <select
        id={`${id}-group`}
        onChange={(event) => onGroupBy(event.target.value)}
        value={groupBy}
      >
        <option value="priority">Priority</option>
        <option value="kind">Kind</option>
        <option value="source">Source</option>
        <option value="blocking">Blocking</option>
        <option value="">None</option>
      </select>
      <label htmlFor={`${id}-kind`}>Kind</label>
      <select
        id={`${id}-kind`}
        onChange={(event) =>
          set("kind", oneOf(KIND_CHOICES, event.target.value) ?? "")
        }
        value={choice.kind}
      >
        <option value="">Any kind</option>
        <option value="task">Task</option>
        <option value="question">Question</option>
      </select>
      <label htmlFor={`${id}-blocking`}>Blocking</label>
      <select
        id={`${id}-blocking`}
        onChange={(event) =>
          set("blocking", oneOf(BLOCKING_CHOICES, event.target.value) ?? "")
        }
        value={choice.blocking}
      >
        <option value="">Any</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      <label htmlFor={`${id}-priority`}>Priority</label>
      <select
        id={`${id}-priority`}
        onChange={(event) =>
          set("priority", oneOf(PRIORITY_CHOICES, event.target.value) ?? "")
        }
        value={choice.priority}
      >
        <option value="">Any priority</option>
        {PRIORITY_OPTIONS.map(({ wire, label }) => (
          <option key={wire} value={wire}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-state`}>State</label>
      <select
        id={`${id}-state`}
        onChange={(event) =>
          set("state", oneOf(STATE_CHOICES, event.target.value) ?? "open")
        }
        value={choice.state}
      >
        {STATE_OPTIONS.map(({ state, label }) => (
          <option key={state} value={state}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-source`}>Source</label>
      <select
        id={`${id}-source`}
        onChange={(event) =>
          set("source", oneOf(SOURCE_CHOICES, event.target.value) ?? "")
        }
        value={choice.source}
      >
        <option value="">Any source</option>
        <option value="session">Session</option>
        <option value="run">Run</option>
        <option value="plan">Plan</option>
        <option value="host">Host</option>
      </select>
      {named && (
        <>
          <label htmlFor={`${id}-source-id`}>Source identifier</label>
          <input
            id={`${id}-source-id`}
            onChange={(event) => set("sourceId", event.target.value)}
            placeholder={`${choice.source} id`}
            type="search"
            value={choice.sourceId}
          />
        </>
      )}
    </fieldset>
  );
}

/** A click on the card itself selects it; a click on one of its controls does not. */
function selectsCard(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest("a, button, textarea, input, select") === null
  );
}

function HumanItemCard({
  view,
  selected,
  state,
  draft,
  refusal,
  onDraft,
  onSelect,
  onWrite,
}: {
  readonly view: HumanItemView;
  readonly selected: boolean;
  readonly state?: WriteState;
  readonly draft: string;
  readonly refusal?: string;
  readonly onDraft: (text: string) => void;
  readonly onSelect: () => void;
  readonly onWrite: Write;
}) {
  const { item } = view;
  const titleId = useId();
  const open = item.state === "open";
  const blocked = blockedSummary(view);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the card's keyboard path is its Details action in the card-action group; this click is the pointer's shortcut to the same thing.
    <article
      aria-labelledby={titleId}
      className="spike-card"
      data-blocking={isBlocking(item)}
      data-selected={selected}
      onClick={(event) => {
        if (selectsCard(event)) onSelect();
      }}
    >
      <div className="spike-card-badges">
        <span className="human-item-priority" data-priority={item.priority}>
          {priorityLabel(item)}
        </span>
        <span className="human-item-kind">{kindLabel(item)}</span>
      </div>
      <h4 id={titleId}>{item.title}</h4>
      <p className="human-item-meta">
        {blocked && (
          <>
            <span className="human-item-blocks">{blocked}</span>
            {" · "}
          </>
        )}
        <span>Source: {sourceWords(item)}</span>
      </p>
      <TaskMarkdown clamp={4} source={item.body} />
      {item.kind === "question" && open && (
        <AnswerBox
          draft={draft}
          label={`Answer: ${item.title}`}
          onDraft={onDraft}
          onSubmit={(text) => onWrite(view, { action: "answer", text })}
          pending={state?.pending ?? false}
        />
      )}
      {refusal && <p className="spike-failed-line">{refusal}</p>}
      <div className="spike-card-actions">
        <CardActions item={view} onSelect={onSelect} onWrite={onWrite} />
      </div>
      <WriteStatus state={state} />
    </article>
  );
}

/** SPIKE: grouping over the fields the plan names. */
function spikeGroups(views: readonly HumanItemView[], field: string) {
  const headingOf = ({ item }: HumanItemView): string =>
    field === "priority"
      ? priorityLabel(item)
      : field === "kind"
        ? kindLabel(item)
        : field === "source"
          ? sourceWords(item)
          : field === "blocking"
            ? isBlocking(item)
              ? "Blocking"
              : "Not blocking"
            : "";
  const groups = new Map<string, HumanItemView[]>();
  for (const view of views) {
    const heading = headingOf(view);
    groups.set(heading, [...(groups.get(heading) ?? []), view]);
  }
  return [...groups].map(([heading, held]) => ({ heading, views: held }));
}

const REFUSAL =
  "Re-read the current document: the design document changed after this approval was raised, so a replacement item now holds the approval.";
const NO_UNDO =
  "Reopen is unavailable: this item's completion script declares no undo, so what it did cannot be taken back here.";

interface Toast {
  readonly action: "complete" | "dismiss";
  readonly view: HumanItemView;
  readonly refused?: string;
}

/** SPIKE: the 15 second toast, without its timer. */
function SpikeToast({
  toast,
  onClose,
}: {
  readonly toast: Toast;
  readonly onClose: () => void;
}) {
  const [help, setHelp] = useState(false);
  const { action, view, refused } = toast;
  const dismissed = action === "dismiss";
  const noUndo = view.item.id === "item-no-undo";
  const close = (
    <button
      aria-label="Close"
      className="spike-toast-close"
      onClick={onClose}
      type="button"
    >
      <X size={14} />
    </button>
  );
  if (refused)
    return (
      <div className="spike-toast" data-failed="true" role="alert">
        <div className="spike-toast-title">
          <p>
            <strong>Not {dismissed ? "dismissed" : "completed"}:</strong>{" "}
            {view.item.title}
          </p>
          {close}
        </div>
        <p className="spike-toast-reason">{refused}</p>
      </div>
    );
  return (
    <div className="spike-toast" role="status">
      <div className="spike-toast-title">
        <p>
          <strong>{dismissed ? "Dismissed" : "Completed"}:</strong>{" "}
          {view.item.title}
        </p>
        {close}
      </div>
      <div className="spike-toast-actions">
        {noUndo ? (
          <span aria-disabled="true" className="spike-greyed">
            {dismissed ? "Restore" : "Reopen"}
            <button
              aria-expanded={help}
              aria-label="Why can't this be reopened?"
              className="spike-help"
              onClick={() => setHelp((value) => !value)}
              title={NO_UNDO}
              type="button"
            >
              ?
            </button>
          </span>
        ) : (
          <button type="button">{dismissed ? "Restore" : "Reopen"}</button>
        )}
        <button type="button">{dismissed ? "Add reason" : "Add comment"}</button>
      </div>
      {help && <p className="spike-toast-reason">{NO_UNDO}</p>}
    </div>
  );
}

/**
 * A card's actions: out of the Tab sequence, so Tab moves only between answer
 * boxes, and reached through the card-action group instead.
 */
function CardActions({
  item: view,
  onSelect,
  onWrite,
}: {
  readonly item: HumanItemView;
  readonly onSelect: () => void;
  readonly onWrite: Write;
}) {
  const { item } = view;
  const open = item.state === "open";
  return (
    <>
      {item.tracker && <TrackerLink cardAction tracker={item.tracker} />}
      <button
        className="human-item-action"
        data-card-action=""
        tabIndex={-1}
        onClick={onSelect}
        type="button"
        aria-label={`Details: ${item.title}`}
      >
        Details
      </button>
      {open && item.kind === "task" && (
        <button
          className="human-item-action"
          data-card-action=""
          tabIndex={-1}
          onClick={() => onWrite(view, { action: "complete" })}
          type="button"
          aria-label={`Complete: ${item.title}`}
        >
          Complete
        </button>
      )}
      {open && (
        <button
          className="human-item-action"
          data-card-action=""
          tabIndex={-1}
          onClick={() => onWrite(view, { action: "dismiss" })}
          type="button"
          aria-label={`Dismiss: ${item.title}`}
        >
          Dismiss
        </button>
      )}
    </>
  );
}

function TrackerLink({
  tracker,
  cardAction = false,
}: {
  readonly tracker: { readonly task: string; readonly url: string };
  /** On a card, the link is one of the card-action group's, out of the Tab order. */
  readonly cardAction?: boolean;
}) {
  const provider = trackerProvider(tracker.url);
  return (
    <a
      data-card-action={cardAction ? "" : undefined}
      tabIndex={cardAction ? -1 : undefined}
      aria-label={`Open ${provider} issue ${tracker.task}`}
      className="human-item-tracker"
      href={tracker.url}
      onClick={(event) => event.stopPropagation()}
      rel="noreferrer"
      target="_blank"
    >
      <ExternalLink aria-hidden="true" size={12} />
      {tracker.task}
    </a>
  );
}

/**
 * An open question's answer, written in place. Enter sends it; Shift+Enter is a
 * new line. It rests one line tall and grows with what is written.
 */
function AnswerBox({
  label,
  draft,
  pending,
  onDraft,
  onSubmit,
}: {
  readonly label: string;
  readonly draft: string;
  readonly pending: boolean;
  readonly onDraft: (text: string) => void;
  readonly onSubmit: (text: string) => void;
}) {
  return (
    <textarea
      aria-busy={pending}
      aria-label={label}
      className="human-item-answer"
      onChange={(event) => onDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (!pending && draft.trim() !== "") onSubmit(draft);
      }}
      placeholder="Answer, then press Enter"
      readOnly={pending}
      rows={1}
      value={draft}
    />
  );
}

function WriteStatus({ state }: { readonly state?: WriteState }) {
  if (state?.pending)
    return (
      <p className="human-item-status" role="status">
        Sending…
      </p>
    );
  if (state?.error)
    return (
      <p className="human-item-status" data-failed="true" role="alert">
        {state.error}
      </p>
    );
  return null;
}

function DetailPane({
  view,
  detail,
  error,
  state,
  draft,
  onDraft,
  onWrite,
  onClose,
}: {
  readonly view?: HumanItemView;
  readonly detail?: HumanItemDetail;
  readonly error?: string;
  readonly state?: WriteState;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onWrite: Write;
  readonly onClose: () => void;
}) {
  const shown = detail ?? view;
  if (shown === undefined)
    return (
      <aside aria-label="Action item detail" className="human-item-detail">
        <Button
          aria-label="Close detail"
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X size={14} />
        </Button>
        {error ? <p role="alert">{error}</p> : <p role="status">Reading…</p>}
      </aside>
    );
  const { item } = shown;
  const open = item.state === "open";
  const phrases = blockedPhrases(shown);
  return (
    <aside aria-label="Action item detail" className="human-item-detail">
      <header className="human-item-detail-head">
        <p className="human-item-meta">
          <span className="human-item-priority" data-priority={item.priority}>
            {priorityLabel(item)}
          </span>{" "}
          {kindLabel(item)} · {stateLabel(item)}
        </p>
        <h2>{item.title}</h2>
        <Button
          aria-label="Close detail"
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X size={14} />
        </Button>
      </header>
      <p className="human-item-meta">Source: {sourceWords(item)}</p>
      {phrases.length > 0 && (
        <p className="human-item-meta human-item-blocks">
          {phrases.join("; ")}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {detail && detail.nodes.length > 0 && (
        <section aria-label="Blocked steps" className="human-item-steps">
          {blockedGroups(detail).map(({ phrase, nodes }) => (
            <div key={phrase}>
              <h3>{phrase}</h3>
              <ul>
                {nodes.map((node) => (
                  <li key={`${node.run}/${node.node}`}>
                    {node.run} / {node.node}: {node.title}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      <section
        aria-label="Full body"
        className="human-item-detail-body"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the body scrolls within the pane, and a region that scrolls has to be reachable by keyboard to be scrolled by one.
        tabIndex={0}
      >
        <TaskMarkdown source={item.body} />
      </section>
      <div className="human-item-detail-actions">
        {item.kind === "question" && open && (
          <AnswerBox
            draft={draft}
            label={`Answer in detail: ${item.title}`}
            onDraft={onDraft}
            onSubmit={(text) => onWrite(shown, { action: "answer", text })}
            pending={state?.pending ?? false}
          />
        )}
        {item.tracker && <TrackerLink tracker={item.tracker} />}
        {open && item.kind === "task" && (
          <Button
            onClick={() => onWrite(shown, { action: "complete" })}
            size="sm"
            type="button"
          >
            Complete
          </Button>
        )}
        {open && (
          <Button
            onClick={() => onWrite(shown, { action: "dismiss" })}
            size="sm"
            type="button"
            variant="outline"
          >
            Dismiss
          </Button>
        )}
        <WriteStatus state={state} />
      </div>
    </aside>
  );
}

/** Dismissal asks for an optional reason before anything is sent. */
function DismissDialog({
  view,
  onConfirm,
  onCancel,
}: {
  readonly view?: HumanItemView;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onCancel();
        }
      }}
      open={view !== undefined}
    >
      <DialogContent>
        <DialogTitle>Dismiss {view?.item.title}</DialogTitle>
        <DialogDescription>
          The item closes without being done. A reason is optional.
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(reason);
            setReason("");
          }}
        >
          <label htmlFor={`${id}-reason`}>Reason (optional)</label>
          <input
            className="human-item-reason"
            id={`${id}-reason`}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
          <DialogFooter>
            <Button type="submit">Dismiss item</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
