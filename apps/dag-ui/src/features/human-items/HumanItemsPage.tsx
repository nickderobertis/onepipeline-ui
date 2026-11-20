import { Button } from "@oneharness/ui";
import type {
  HumanItemChoice,
  HumanItemDetail,
  HumanItemView,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { TaskCard, TaskMarkdown, TaskSourceLink } from "@onetaskgraph/ui";
import { SlidersHorizontal, X } from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { LiveHumanItems } from "../../lib/live-human-items";
import { Timestamp } from "../../lib/Timestamp";
import { formatParsedAbsolute, parseTimestamp } from "../../lib/time";
import { HumanItemToast } from "./HumanItemToast";
import type { Draft } from "./human-item-drafts";
import {
  BLOCKING_CHOICES,
  blockedGroups,
  blockedSummary,
  changedFilters,
  DEFAULT_GROUP_BY,
  type FilterChoice,
  GROUP_CHOICES,
  GROUP_OPTIONS,
  type GroupBy,
  groupItems,
  historyWords,
  isBlocking,
  KIND_CHOICES,
  kindLabel,
  metadataFields,
  oneOf,
  PRIORITY_CHOICES,
  PRIORITY_OPTIONS,
  priorityLabel,
  SORT_CHOICES,
  SORT_OPTIONS,
  SOURCE_CHOICES,
  type SortOrder,
  STATE_CHOICES,
  STATE_OPTIONS,
  savedNote,
  sourceWords,
  stateLabel,
} from "./human-items-model";
import { ReopenAction } from "./ReopenAction";
import { SendBar } from "./SendBar";
import {
  type HumanItemWrite,
  useHumanItems,
  type WriteState,
} from "./useHumanItems";
import { useListOrder } from "./useListOrder";

/** Marks every card control that belongs to the card-action group. */
const CARD_ACTION = "data-card-action";

/** The lines of a body a card shows; the detail pane shows the rest. */
const CARD_BODY_LINES = 4;

type Write = (view: HumanItemView, change: HumanItemWrite) => void;

/** What every answer control needs: one item's draft, and how to change it. */
interface Answering {
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly refusals: Readonly<Record<string, string>>;
  readonly sending: boolean;
  readonly pressChoice: (view: HumanItemView, choice: HumanItemChoice) => void;
  readonly setText: (view: HumanItemView, text: string) => void;
}

/**
 * The host-wide action items: tasks and questions the operator's attention is
 * asked for, under a heading per value of the field they are grouped by, with
 * the open questions answerable in place: an answer is drafted, by a choice,
 * the person's words or both, and the send bar sends every draft as one batch.
 * Complete and Dismiss act at once and leave a toast that can take the write
 * back or say why.
 *
 * Keyboard: Tab moves from one open question's answer controls straight to the
 * next: its choice buttons, or its answer box where it offers none, and nothing
 * else on a card is in that sequence. After the last of them
 * comes the card-action group — tracker links, Details, Complete and Dismiss —
 * which the arrow keys move through; Enter follows a focused link, and Enter
 * or Space presses a focused button.
 */
export function HumanItemsPage({
  client,
  live,
  choice,
  setChoice,
  selectedId,
  setSelectedId,
}: {
  readonly client: TelemetryClient;
  /** What the tab's one subscription holds of this page. */
  readonly live: LiveHumanItems;
  readonly choice: FilterChoice;
  readonly setChoice: (choice: FilterChoice) => void;
  readonly selectedId: string | undefined;
  readonly setSelectedId: (id: string | undefined) => void;
}) {
  const items = useHumanItems(
    client,
    live,
    selectedId,
    choice.state,
    JSON.stringify(choice),
  );
  const { groupBy, setGroupBy, sort, setSort } = useListOrder();
  const [room, setRoom] = useState(0);
  const [sendRoom, setSendRoom] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const selected =
    items.items?.find(({ item }) => item.id === selectedId) ?? items.detail;
  // What the pane last showed of the open item, for when it no longer reads.
  const lastShown = useRef<HumanItemView>(undefined);
  if (selected !== undefined) lastShown.current = selected;
  else if (lastShown.current?.item.id !== selectedId)
    lastShown.current = undefined;

  const shownId = useRef(selectedId);
  shownId.current = selectedId;
  const write: Write = (view, change) => {
    // Once the engine took it, the item is resolved as far as this page is
    // concerned: its detail closes with its card, rather than lingering on
    // something no one is to act on. Until then both stay, the press pending.
    items.write(view, change, () => {
      if (shownId.current === view.item.id) setSelectedId(undefined);
    });
  };

  // A write that failed put its card back: bring it into view above the toast.
  const returned = items.returned;
  useEffect(() => {
    if (returned === undefined) return;
    listRef.current
      ?.querySelector(`[data-item-id="${CSS.escape(returned.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [returned]);

  const groups = groupItems(items.items ?? [], groupBy, sort);
  return (
    <section
      aria-label="Action items"
      className="human-items-page"
      data-detail-open={selectedId !== undefined}
      style={pageRoom(room, sendRoom)}
    >
      <Filters
        choice={choice}
        groupBy={groupBy}
        onChange={setChoice}
        onGroupBy={setGroupBy}
        onSort={setSort}
        sort={sort}
      />
      <div className="human-items-body">
        <section aria-label="Action item list" className="human-items-list">
          {items.listError && <p role="alert">{items.listError}</p>}
          {items.items === undefined && !items.listError && (
            <p role="status">Reading action items…</p>
          )}
          {items.items?.length === 0 && (
            <p role="status">No action items match these filters.</p>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move focus among the card actions inside; the container itself is never focused. */}
          <div
            className="human-items-groups"
            onKeyDown={(event) => roveCardActions(event, listRef.current)}
            ref={listRef}
          >
            {groups.map((group) => (
              <ItemGroupList
                answering={items.answers}
                group={group}
                groupBy={groupBy}
                key={group.key}
                onSelect={setSelectedId}
                onWrite={write}
                selectedId={selectedId}
                writes={items.writes}
              />
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
            answering={items.answers}
            error={items.detailError}
            detail={items.detail}
            gone={items.gone}
            lastShown={lastShown.current}
            onClose={() => setSelectedId(undefined)}
            onWrite={write}
            state={items.writes[selectedId]}
            view={selected}
          />
        )}
      </div>
      <SendBar answers={items.answers} onRoom={setSendRoom} />
      {items.toast && (
        <HumanItemToast
          onClose={items.closeToast}
          onNote={items.note}
          onRoom={setRoom}
          onUndo={items.undo}
          toast={items.toast}
        />
      )}
    </section>
  );
}

/**
 * The room the list keeps below its last card while a toast shows, and how far
 * up the toast sits to clear the send bar: custom properties, which
 * `CSSProperties` does not name, so they are declared beside it.
 */
function pageRoom(
  toast: number,
  send: number,
): CSSProperties & {
  readonly "--toast-room": string;
  readonly "--send-room": string;
} {
  return { "--toast-room": `${toast}px`, "--send-room": `${send}px` };
}

/** One heading's cards, or the whole list when nothing groups it. */
function ItemGroupList({
  group,
  groupBy,
  selectedId,
  writes,
  answering,
  onSelect,
  onWrite,
}: {
  readonly group: ReturnType<typeof groupItems>[number];
  readonly groupBy: GroupBy;
  readonly selectedId: string | undefined;
  readonly writes: Readonly<Record<string, WriteState>>;
  readonly answering: Answering;
  readonly onSelect: (id: string) => void;
  readonly onWrite: Write;
}) {
  const headingId = useId();
  const cards = group.items.map((view) => (
    <li key={view.item.id}>
      <HumanItemCard
        answering={answering}
        groupBy={groupBy}
        onSelect={() => onSelect(view.item.id)}
        onWrite={onWrite}
        selected={view.item.id === selectedId}
        state={writes[view.item.id]}
        view={view}
      />
    </li>
  ));
  if (group.label === undefined)
    return <ul aria-label="Action items">{cards}</ul>;
  return (
    <section aria-labelledby={headingId} className="human-items-group">
      <h2 className="human-items-group-heading" id={headingId}>
        {group.label}{" "}
        <span className="human-items-group-count">({group.items.length})</span>
      </h2>
      <ul aria-labelledby={headingId}>{cards}</ul>
    </section>
  );
}

/** Arrow keys, Home and End move focus through every card action in the list. */
function roveCardActions(
  event: KeyboardEvent<HTMLElement>,
  list: HTMLElement | null,
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

/**
 * Group by, Sort and the filters. At phone width they fold behind one Filters
 * button, closed until pressed, which counts the choices that differ from the
 * defaults; Sort stays out beside it, one tap away, and is not counted.
 */
function Filters({
  choice,
  groupBy,
  sort,
  onChange,
  onGroupBy,
  onSort,
}: {
  readonly choice: FilterChoice;
  readonly groupBy: GroupBy;
  readonly sort: SortOrder;
  readonly onChange: (choice: FilterChoice) => void;
  readonly onGroupBy: (groupBy: GroupBy) => void;
  readonly onSort: (sort: SortOrder) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const set = <K extends keyof FilterChoice>(key: K, value: FilterChoice[K]) =>
    onChange({ ...choice, [key]: value });
  const named = choice.source !== "" && choice.source !== "host";
  const changed = changedFilters(choice) + Number(groupBy !== DEFAULT_GROUP_BY);
  return (
    <div className="human-items-controls" data-open={open}>
      <button
        aria-controls={`${id}-filters`}
        aria-expanded={open}
        aria-label={changed > 0 ? `Filters, ${changed} changed` : "Filters"}
        className="human-items-filters-toggle"
        onClick={() => setOpen((shown) => !shown)}
        type="button"
      >
        <SlidersHorizontal aria-hidden="true" size={14} />
        Filters
        {changed > 0 && (
          <span aria-hidden="true" className="human-items-filters-count">
            {changed}
          </span>
        )}
      </button>
      <select
        aria-label="Sort"
        className="human-items-sort-toggle"
        onChange={(event) => onSort(sortOf(event.target.value))}
        value={sort}
      >
        {SORT_OPTIONS.map(({ value, label }) => (
          <option key={value} value={value}>
            Sort: {label}
          </option>
        ))}
      </select>
      <fieldset className="human-items-filters" id={`${id}-filters`}>
        <legend className="sr-only">Filter action items</legend>
        <label htmlFor={`${id}-group`}>Group by</label>
        <select
          id={`${id}-group`}
          onChange={(event) =>
            onGroupBy(oneOf(GROUP_CHOICES, event.target.value) ?? "priority")
          }
          value={groupBy}
        >
          {GROUP_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="human-items-sort-label" htmlFor={`${id}-sort`}>
          Sort
        </label>
        <select
          className="human-items-sort-select"
          id={`${id}-sort`}
          onChange={(event) => onSort(sortOf(event.target.value))}
          value={sort}
        >
          {SORT_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
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
    </div>
  );
}

function sortOf(value: string): SortOrder {
  return oneOf(SORT_CHOICES, value) ?? "default";
}

/**
 * A click on the card itself selects it; a click on one of its controls, or the
 * one a finger sends on lifting from a long press of its raised time, does not.
 */
function selectsCard(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(
      'a, button, textarea, input, select, [data-long-pressed="true"]',
    ) === null
  );
}

/**
 * An item's badges: priority, kind, and whether it blocks — leaving out the one
 * the list is grouped by, whose heading already says it.
 */
function Badges({
  view,
  groupBy,
}: {
  readonly view: HumanItemView;
  readonly groupBy?: GroupBy;
}) {
  const { item } = view;
  return (
    <>
      {groupBy !== "priority" && (
        <span className="human-item-priority" data-priority={item.priority}>
          {priorityLabel(item)}
        </span>
      )}
      {groupBy !== "kind" && (
        <span className="human-item-kind">{kindLabel(item)}</span>
      )}
      {groupBy !== "blocking" && isBlocking(item) && (
        <span className="human-item-blocking">Blocking</span>
      )}
    </>
  );
}

function HumanItemCard({
  view,
  groupBy,
  selected,
  state,
  answering,
  onSelect,
  onWrite,
}: {
  readonly view: HumanItemView;
  readonly groupBy: GroupBy;
  readonly selected: boolean;
  readonly state?: WriteState;
  readonly answering: Answering;
  readonly onSelect: () => void;
  readonly onWrite: Write;
}) {
  const { item } = view;
  const open = item.state === "open";
  const blocked = blockedSummary(view);
  const meta: readonly { readonly key: string; readonly part: ReactNode }[] = [
    { key: "raised", part: <RaisedAt at={item.created_at} /> },
    ...(open ? [] : [{ key: "state", part: stateLabel(item) }]),
    ...(blocked ? [{ key: "blocked", part: blocked }] : []),
    ...(groupBy === "source"
      ? []
      : [{ key: "source", part: `Source: ${sourceWords(item)}` }]),
  ];
  const offers = (item.choices?.length ?? 0) > 0;
  const note = savedNote(item);
  return (
    <TaskCard
      actions={
        <CardActions
          item={view}
          onSelect={onSelect}
          onWrite={onWrite}
          state={state}
        />
      }
      badges={<Badges groupBy={groupBy} view={view} />}
      body={item.body}
      className="human-item-card"
      clamp={CARD_BODY_LINES}
      data-blocking={isBlocking(item)}
      data-item-id={item.id}
      data-selected={selected}
      meta={meta.map(({ key, part }, index) => (
        <Fragment key={key}>
          {index > 0 && " · "}
          <span>{part}</span>
        </Fragment>
      ))}
      onClick={(event) => {
        if (selectsCard(event)) onSelect();
      }}
      title={item.title}
    >
      {item.kind === "question" && open && offers && (
        <fieldset className="human-item-choices">
          <legend className="sr-only">Choices: {item.title}</legend>
          {item.choices?.map((choice) => (
            <ChoiceButton
              answering={answering}
              choice={choice}
              key={choice.id}
              view={view}
            />
          ))}
        </fieldset>
      )}
      {/* Beside the choices too, as the detail pane offers it: a person can
          always answer in their own words. */}
      {item.kind === "question" && open && (
        <AnswerBox
          answering={answering}
          label={`Answer: ${item.title}`}
          view={view}
        />
      )}
      <AnsweredBlock view={view} />
      {note && <SavedNote label={note.label} text={note.text} />}
      <RefusalNote reason={answering.refusals[item.id]} />
      <WriteStatus state={state} />
    </TaskCard>
  );
}

/**
 * A card's actions: out of the Tab sequence, so Tab moves only between answer
 * boxes, and reached through the card-action group instead.
 */
function CardActions({
  item: view,
  state,
  onSelect,
  onWrite,
}: {
  readonly item: HumanItemView;
  readonly state?: WriteState;
  readonly onSelect: () => void;
  readonly onWrite: Write;
}) {
  const { item } = view;
  const open = item.state === "open";
  const pending = state?.pending;
  return (
    <>
      {item.tracker && (
        <TaskSourceLink
          className="human-item-tracker"
          data-card-action=""
          label={item.tracker.task}
          title={item.tracker.task}
          // On a card the link is one of the card-action group's, and following
          // it never selects the card.
          onClick={(event) => event.stopPropagation()}
          tabIndex={-1}
          url={item.tracker.url}
        />
      )}
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
        <WriteButton
          action="complete"
          control={CARD_CONTROL}
          className="human-item-action"
          name={`Complete: ${item.title}`}
          onPress={() => onWrite(view, { action: "complete" })}
          pending={pending}
        />
      )}
      {open && (
        <WriteButton
          action="dismiss"
          control={CARD_CONTROL}
          className="human-item-action"
          name={`Dismiss: ${item.title}`}
          onPress={() => onWrite(view, { action: "dismiss" })}
          pending={pending}
        />
      )}
      {!open && (
        <ReopenAction
          busyLabel="Reopening…"
          className="human-item-action"
          control={CARD_CONTROL}
          disabled={pending !== undefined}
          label="Reopen"
          item={item.title}
          onPress={() => onWrite(view, { action: "reopen" })}
          reopen={view.reopen}
          sending={pending === "reopen"}
        />
      )}
    </>
  );
}

/** What puts a card's control in the card-action group, out of the Tab sequence. */
const CARD_CONTROL: CardControl = { [CARD_ACTION]: "", tabIndex: -1 };

const WRITE_WORDS = {
  complete: { label: "Complete", busy: "Completing…" },
  dismiss: { label: "Dismiss", busy: "Dismissing…" },
} as const;

/**
 * Complete or Dismiss: while its write is out it reads as pending, busy and
 * disabled, and while any write on the item is out it waits for that one.
 */
function WriteButton({
  action,
  name,
  pending,
  onPress,
  className,
  control = {},
  children,
}: {
  readonly action: keyof typeof WRITE_WORDS;
  readonly name?: string;
  readonly pending: WriteState["pending"];
  readonly onPress: () => void;
  readonly className?: string;
  readonly control?: CardControl;
  /** Wraps the button, for one drawn by the design system's own `Button`. */
  readonly children?: (props: WriteButtonProps) => ReactNode;
}) {
  const sending = pending === action;
  const words = WRITE_WORDS[action];
  const props: WriteButtonProps = {
    ...control,
    "aria-busy": sending,
    "aria-label": sending ? undefined : name,
    className,
    disabled: pending !== undefined,
    onClick: onPress,
    type: "button",
    children: sending ? words.busy : words.label,
  };
  return children ? children(props) : <button {...props} />;
}

/** What puts a control in the card-action group, where it is one. */
export interface CardControl {
  readonly "data-card-action"?: string;
  readonly tabIndex?: number;
}

interface WriteButtonProps extends CardControl {
  readonly "aria-busy": boolean;
  readonly "aria-label": string | undefined;
  readonly className: string | undefined;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly type: "button";
  readonly children: string;
}

/**
 * When an item was raised, as an age on its card, with the exact moment on
 * hover — and on a long press, which is the one a phone has.
 */
function RaisedAt({ at }: { readonly at: string }) {
  const [held, setHeld] = useState(false);
  // Set from the moment a long press shows the moment until the next press:
  // the click a lifted finger sends after it is no press on the card.
  const [pressedLong, setPressedLong] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tip = useId();
  const parsed = parseTimestamp(at);
  const cancel = () => clearTimeout(timer.current);
  return (
    <span
      aria-describedby={held ? tip : undefined}
      className="human-item-raised"
      data-long-pressed={pressedLong}
      // A press target of its own, out of the Tab sequence: a finger on the
      // time is otherwise moved by the browser to the card's buttons just above.
      tabIndex={-1}
      onPointerCancel={cancel}
      onPointerDown={(event) => {
        setPressedLong(false);
        if (event.pointerType === "mouse") return;
        cancel();
        timer.current = setTimeout(() => {
          setHeld(true);
          setPressedLong(true);
        }, LONG_PRESS_MS);
      }}
      onPointerLeave={() => {
        cancel();
        setHeld(false);
      }}
      onPointerUp={cancel}
    >
      Raised <Timestamp at={at} relative />
      {held && parsed !== undefined && (
        <span className="human-item-raised-tip" id={tip} role="tooltip">
          {formatParsedAbsolute(parsed)}
        </span>
      )}
    </span>
  );
}

/** How long a press is held before it reads as a long press, in milliseconds. */
const LONG_PRESS_MS = 500;

/** A reason or comment a reader saved on resolving the item. */
function SavedNote({
  label,
  text,
}: {
  readonly label: string;
  readonly text: string;
}) {
  return (
    <p className="human-item-note">
      <span className="human-item-note-label">{label}:</span> {text}
    </p>
  );
}

/** One choice as a press: pressed once it is the draft's, and again to clear it. */
function ChoiceButton({
  view,
  choice,
  answering,
}: {
  readonly view: HumanItemView;
  readonly choice: HumanItemChoice;
  readonly answering: Answering;
}) {
  const pressed = answering.drafts[view.item.id]?.choice === choice.id;
  return (
    <button
      aria-pressed={pressed}
      className="human-item-choice"
      disabled={answering.sending}
      onClick={() => answering.pressChoice(view, choice)}
      type="button"
    >
      {choice.title}
    </button>
  );
}

/**
 * An open question's own words, written in place and held as its draft. Enter
 * keeps the draft and never sends it: the send bar is the one way out. Shift+Enter
 * is a new line. It rests one line tall and grows with what is written.
 */
function AnswerBox({
  view,
  label,
  answering,
}: {
  readonly view: HumanItemView;
  readonly label: string;
  readonly answering: Answering;
}) {
  return (
    <textarea
      aria-busy={answering.sending}
      aria-label={label}
      className="human-item-answer"
      onChange={(event) => answering.setText(view, event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
      }}
      placeholder={
        (view.item.choices?.length ?? 0) > 0
          ? "Or write your own answer"
          : "Write an answer"
      }
      readOnly={answering.sending}
      rows={1}
      value={answering.drafts[view.item.id]?.text ?? ""}
    />
  );
}

/** What an answered question was answered with: untrusted, as a body is. */
function AnsweredBlock({ view }: { readonly view: HumanItemView }) {
  const { item } = view;
  if (item.state !== "answered" || item.resolution === null) return null;
  const { choice, text } = item.resolution;
  const picked = item.choices?.find(({ id }) => id === choice);
  return (
    <section aria-label="Answer" className="human-item-answered">
      {picked && <p className="human-item-answered-choice">{picked.title}</p>}
      {text !== null && <TaskMarkdown source={text} />}
    </section>
  );
}

function RefusalNote({ reason }: { readonly reason: string | undefined }) {
  if (reason === undefined) return null;
  return (
    <p className="human-item-status" data-failed="true" role="alert">
      Not sent: {reason}
    </p>
  );
}

function WriteStatus({ state }: { readonly state?: WriteState }) {
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
  gone,
  lastShown,
  error,
  state,
  answering,
  onWrite,
  onClose,
}: {
  readonly view?: HumanItemView;
  readonly detail?: HumanItemDetail;
  /** The item no longer reads: whatever became of it, it is no one's to act on. */
  readonly gone: boolean;
  readonly lastShown?: HumanItemView;
  readonly error?: string;
  readonly state?: WriteState;
  readonly answering: Answering;
  readonly onWrite: Write;
  readonly onClose: () => void;
}) {
  if (gone && view === undefined)
    return (
      <aside aria-label="Action item detail" className="human-item-detail">
        <header className="human-item-detail-head">
          {lastShown && <h2>{lastShown.item.title}</h2>}
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
        <p role="status">Resolved: this item needs nothing more from you.</p>
      </aside>
    );
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
  const choices = item.choices ?? [];
  const asking = item.kind === "question" && open;
  return (
    <aside
      aria-label="Action item detail"
      className="human-item-detail"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the detail scrolls as a whole, and a region that scrolls has to be reachable by keyboard to be scrolled by one.
      tabIndex={0}
    >
      <header className="human-item-detail-head">
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
      {error && <p role="alert">{error}</p>}
      <section aria-label="Full body" className="human-item-detail-body">
        <TaskMarkdown source={item.body} />
      </section>
      {asking && choices.length > 0 && (
        <fieldset className="human-item-choice-list">
          <legend>Choices</legend>
          {choices.map((choice) => (
            <div className="human-item-choice-entry" key={choice.id}>
              <ChoiceButton
                answering={answering}
                choice={choice}
                view={shown}
              />
              <div className="human-item-choice-description">
                <TaskMarkdown source={choice.description} />
              </div>
            </div>
          ))}
        </fieldset>
      )}
      {asking && (
        <AnswerBox
          answering={answering}
          label={`Answer in detail: ${item.title}`}
          view={shown}
        />
      )}
      <AnsweredBlock view={shown} />
      <RefusalNote reason={answering.refusals[item.id]} />
      <div className="human-item-detail-actions">
        {open && item.kind === "task" && (
          <WriteButton
            action="complete"
            onPress={() => onWrite(shown, { action: "complete" })}
            pending={state?.pending}
          >
            {(props) => <Button {...props} size="sm" />}
          </WriteButton>
        )}
        {open && (
          <WriteButton
            action="dismiss"
            onPress={() => onWrite(shown, { action: "dismiss" })}
            pending={state?.pending}
          >
            {(props) => <Button {...props} size="sm" variant="outline" />}
          </WriteButton>
        )}
        {!open && (
          <ReopenAction
            busyLabel="Reopening…"
            className="human-item-detail-reopen"
            disabled={state?.pending !== undefined}
            label="Reopen"
            onPress={() => onWrite(shown, { action: "reopen" })}
            reopen={shown.reopen}
            sending={state?.pending === "reopen"}
          />
        )}
        <WriteStatus state={state} />
      </div>
      {detail?.history !== undefined && detail.history.length > 0 && (
        <History history={detail.history} />
      )}
      <dl className="human-item-metadata">
        {metadataFields(shown).map((field) => (
          <Fragment key={field.label}>
            <dt>{field.label}</dt>
            <dd>
              {"value" in field ? (
                field.value
              ) : (
                <>
                  {field.party !== undefined && `By ${field.party} · `}
                  <Timestamp at={field.at} relative />
                </>
              )}
            </dd>
          </Fragment>
        ))}
        {detail && detail.nodes.length > 0 && (
          <>
            <dt>Blocked steps</dt>
            <dd>
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
            </dd>
          </>
        )}
        {item.tracker && (
          <>
            <dt>Tracker</dt>
            <dd>
              <TaskSourceLink
                className="human-item-tracker-full"
                label={item.tracker.task}
                url={item.tracker.url}
              />
            </dd>
          </>
        )}
      </dl>
    </aside>
  );
}

/**
 * The engine's history of the item, as the detail route served it, oldest
 * first: one row per entry, its action and party in the pane's own words and
 * its moment as an age. Who made each ruling is context a reader reaches for,
 * so it is plain text in the pane's one style, never a badge or a colour.
 */
function History({
  history,
}: {
  readonly history: NonNullable<HumanItemDetail["history"]>;
}) {
  return (
    <section aria-label="History" className="human-item-history">
      <h3>History</h3>
      <ol>
        {history.map((entry, index) => (
          // The engine's order is the entry's identity: two raises can share
          // an instant, and nothing else tells them apart.
          // biome-ignore lint/suspicious/noArrayIndexKey: the served list is append-only and oldest first, so an entry's position is stable.
          <li key={index}>
            {historyWords(entry)}
            {" · "}
            <Timestamp at={entry.at} relative />
          </li>
        ))}
      </ol>
    </section>
  );
}
