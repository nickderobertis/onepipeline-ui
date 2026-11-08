import { Button } from "@oneharness/ui";
import type { HumanItemDetail, HumanItemView } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { TaskCard, TaskMarkdown, TaskSourceLink } from "@onetaskgraph/ui";
import { SlidersHorizontal, X } from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { LiveHumanItems } from "../../lib/live-human-items";
import {
  AnsweredLine,
  ChoiceButtons,
  ChoiceList,
  mockHumanItems,
  mockStage,
  SendBar,
  showsChoices,
} from "./ChoicesMock";
import { HumanItemToast } from "./HumanItemToast";
import {
  BLOCKING_CHOICES,
  blockedGroups,
  blockedPhrases,
  blockedSummary,
  changedFilters,
  DEFAULT_GROUP_BY,
  type FilterChoice,
  GROUP_CHOICES,
  GROUP_OPTIONS,
  type GroupBy,
  groupItems,
  isBlocking,
  KIND_CHOICES,
  kindLabel,
  oneOf,
  PRIORITY_CHOICES,
  PRIORITY_OPTIONS,
  priorityLabel,
  SOURCE_CHOICES,
  STATE_CHOICES,
  STATE_OPTIONS,
  sourceWords,
  stateLabel,
} from "./human-items-model";
import { useGroupBy } from "./useGroupBy";
import {
  type HumanItemWrite,
  useHumanItems,
  type WriteState,
} from "./useHumanItems";

/** Marks every card control that belongs to the card-action group. */
const CARD_ACTION = "data-card-action";

/** The lines of a body a card shows; the detail pane shows the rest. */
const CARD_BODY_LINES = 4;

type Write = (view: HumanItemView, change: HumanItemWrite) => void;

/**
 * The host-wide action items: tasks and questions the operator's attention is
 * asked for, under a heading per value of the field they are grouped by, with
 * the open questions answerable in place. Complete and Dismiss act at once and
 * leave a toast that can take the write back or say why.
 *
 * Keyboard: Tab moves from one open question's answer box straight to the next,
 * and nothing else on a card is in that sequence. After the last answer box
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
  const realItems = useHumanItems(
    client,
    live,
    selectedId,
    choice.state,
    JSON.stringify(choice),
  );
  // SPIKE: `?mock=<stage>` swaps in the six-item fixture.
  const stage = mockStage();
  const items =
    stage === undefined
      ? realItems
      : mockHumanItems(stage, realItems, selectedId);
  if (stage === "answered") choice = { ...choice, state: "answered" };
  const { groupBy, setGroupBy } = useGroupBy();
  const [room, setRoom] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const selected =
    items.items?.find(({ item }) => item.id === selectedId) ?? items.detail;
  // What the pane last showed of the open item, for when it no longer reads.
  const lastShown = useRef<HumanItemView>(undefined);
  if (selected !== undefined) lastShown.current = selected;
  else if (lastShown.current?.item.id !== selectedId)
    lastShown.current = undefined;

  const write: Write = (view, change) => {
    // The item is resolved as far as this page is concerned: its detail closes
    // with its card, rather than lingering on something no one is to act on.
    if (change.action !== "answer" && view.item.id === selectedId)
      setSelectedId(undefined);
    items.write(view, change);
  };

  // A write that failed put its card back: bring it into view above the toast.
  const returned = items.returned;
  useEffect(() => {
    if (returned === undefined) return;
    listRef.current
      ?.querySelector(`[data-item-id="${CSS.escape(returned.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [returned]);

  const groups = groupItems(items.items ?? [], groupBy);
  return (
    <section
      aria-label="Action items"
      className="human-items-page"
      data-detail-open={selectedId !== undefined}
      style={toastRoom(room)}
    >
      <Filters
        choice={choice}
        groupBy={groupBy}
        onChange={setChoice}
        onGroupBy={setGroupBy}
      />
      <div className="human-items-body">
        <section
          aria-label="Action item list"
          className="human-items-list"
          data-mock={stage}
        >
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
                draftOf={(id) => items.drafts[id] ?? ""}
                group={group}
                groupBy={groupBy}
                key={group.key}
                onDraft={items.setDraft}
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
          {showsChoices(stage) && stage && <SendBar stage={stage} />}
        </section>
        {selectedId !== undefined && (
          <DetailPane
            draft={items.drafts[selectedId] ?? ""}
            error={items.detailError}
            detail={items.detail}
            gone={items.gone}
            lastShown={lastShown.current}
            onClose={() => setSelectedId(undefined)}
            onDraft={(text) => items.setDraft(selectedId, text)}
            onWrite={write}
            state={items.writes[selectedId]}
            view={selected}
          />
        )}
      </div>
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
 * The room the list keeps below its last card while a toast shows: a custom
 * property, which `CSSProperties` does not name, so it is declared beside it.
 */
function toastRoom(
  height: number,
): CSSProperties & { readonly "--toast-room": string } {
  return { "--toast-room": `${height}px` };
}

/** One heading's cards, or the whole list when nothing groups it. */
function ItemGroupList({
  group,
  groupBy,
  selectedId,
  writes,
  draftOf,
  onDraft,
  onSelect,
  onWrite,
}: {
  readonly group: ReturnType<typeof groupItems>[number];
  readonly groupBy: GroupBy;
  readonly selectedId: string | undefined;
  readonly writes: Readonly<Record<string, WriteState>>;
  readonly draftOf: (id: string) => string;
  readonly onDraft: (id: string, text: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onWrite: Write;
}) {
  const headingId = useId();
  const cards = group.items.map((view) => (
    <li key={view.item.id}>
      <HumanItemCard
        draft={draftOf(view.item.id)}
        groupBy={groupBy}
        onDraft={(text) => onDraft(view.item.id, text)}
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
 * Group by and the filters. At phone width they fold behind one Filters button,
 * closed until pressed, which counts the choices that differ from the defaults.
 */
function Filters({
  choice,
  groupBy,
  onChange,
  onGroupBy,
}: {
  readonly choice: FilterChoice;
  readonly groupBy: GroupBy;
  readonly onChange: (choice: FilterChoice) => void;
  readonly onGroupBy: (groupBy: GroupBy) => void;
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

/** A click on the card itself selects it; a click on one of its controls does not. */
function selectsCard(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest("a, button, textarea, input, select") === null
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
  draft,
  onDraft,
  onSelect,
  onWrite,
}: {
  readonly view: HumanItemView;
  readonly groupBy: GroupBy;
  readonly selected: boolean;
  readonly state?: WriteState;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onSelect: () => void;
  readonly onWrite: Write;
}) {
  const { item } = view;
  const stage = mockStage();
  const open = item.state === "open";
  const blocked = blockedSummary(view);
  const meta = [
    ...(open ? [] : [stateLabel(item)]),
    ...(blocked ? [blocked] : []),
    ...(groupBy === "source" ? [] : [`Source: ${sourceWords(item)}`]),
  ];
  return (
    <TaskCard
      actions={
        <CardActions item={view} onSelect={onSelect} onWrite={onWrite} />
      }
      badges={<Badges groupBy={groupBy} view={view} />}
      body={item.body}
      className="human-item-card"
      clamp={CARD_BODY_LINES}
      data-blocking={isBlocking(item)}
      data-item-id={item.id}
      data-selected={selected}
      meta={
        meta.length === 0
          ? undefined
          : meta.map((part, index) => (
              <Fragment key={part}>
                {index > 0 && " · "}
                <span>{part}</span>
              </Fragment>
            ))
      }
      onClick={(event) => {
        if (selectsCard(event)) onSelect();
      }}
      title={item.title}
    >
      {showsChoices(stage) && stage && item.kind === "question" && open && (
        <ChoiceButtons id={item.id} stage={stage} title={item.title} />
      )}
      {showsChoices(stage) && stage && item.state === "answered" && (
        <AnsweredLine stage={stage} view={view} />
      )}
      {item.kind === "question" && open && (
        <AnswerBox
          draft={draft}
          label={`Answer: ${item.title}`}
          placeholder={
            showsChoices(stage) ? "Or answer in your own words" : undefined
          }
          onDraft={onDraft}
          onSubmit={(text) => onWrite(view, { action: "answer", text })}
          pending={state?.pending ?? false}
        />
      )}
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
      {item.tracker && (
        <TaskSourceLink
          className="human-item-tracker"
          data-card-action=""
          label={item.tracker.task}
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
  placeholder,
}: {
  readonly label: string;
  readonly draft: string;
  readonly pending: boolean;
  readonly onDraft: (text: string) => void;
  readonly onSubmit: (text: string) => void;
  readonly placeholder?: string | undefined;
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
      placeholder={placeholder ?? "Answer, then press Enter"}
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
  gone,
  lastShown,
  error,
  state,
  draft,
  onDraft,
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
  readonly draft: string;
  readonly onDraft: (text: string) => void;
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
  const stage = mockStage();
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
      {showsChoices(stage) && stage && item.kind === "question" && open && (
        <div className="mock-detail-answer">
          <ChoiceList id={item.id} stage={stage} />
          <AnswerBox
            draft={draft}
            label={`Answer in detail: ${item.title}`}
            onDraft={onDraft}
            onSubmit={() => undefined}
            pending={false}
            placeholder="Add a note to the choice, or answer in your own words"
          />
        </div>
      )}
      <div className="human-item-detail-actions">
        {item.kind === "question" && open && !showsChoices(stage) && (
          <AnswerBox
            draft={draft}
            label={`Answer in detail: ${item.title}`}
            onDraft={onDraft}
            onSubmit={(text) => onWrite(shown, { action: "answer", text })}
            pending={state?.pending ?? false}
          />
        )}
        {item.tracker && (
          <TaskSourceLink
            className="human-item-tracker"
            label={item.tracker.task}
            url={item.tracker.url}
          />
        )}
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
