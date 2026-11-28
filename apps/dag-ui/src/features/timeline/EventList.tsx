import {
  EVENT_TYPES,
  type EventType,
  eventTypeLabel,
} from "@onepipeline-ui/timeline-categories";
import { ChevronDown, Repeat2 } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Timestamp } from "../../lib/Timestamp";
import { formatDuration } from "../../lib/time";
import { KindLabel, ROW_KINDS, type RowKind } from "./spike-grouped";
import { cycleLabel, type TranscriptEntry } from "./timeline-model";

/**
 * The head of an event list: its name, and the one control that narrows it to the
 * types a reader wants.
 *
 * The control sits with the events it narrows rather than in the run's bar,
 * because it shapes this list and nothing else on the page: the plot above it
 * and every other view of the run read the whole journal whatever it says.
 */
export function EventListHeader({
  counts,
  hidden,
  onHiddenChange,
  spikeCounts,
}: {
  /** SPIKE: the reader-named kinds, which the filter lists in place of the types. */
  readonly spikeCounts?: ReadonlyMap<RowKind, number>;
  /** How many rows of each type the list holds, whatever is hidden. */
  readonly counts: ReadonlyMap<EventType, number>;
  readonly hidden: ReadonlySet<EventType>;
  readonly onHiddenChange: (hidden: readonly EventType[]) => void;
}) {
  // The types this list holds, and any the reader hid that it does not hold now,
  // so a type hidden on another node can be shown again from here.
  const offered = EVENT_TYPES.filter(
    (type) => (counts.get(type) ?? 0) > 0 || hidden.has(type),
  );
  const shown = offered.filter((type) => !hidden.has(type)).length;
  const counted = useId();
  if (spikeCounts !== undefined && spikeCounts.size > 0) {
    const kinds = ROW_KINDS.filter((kind) => (spikeCounts.get(kind) ?? 0) > 0);
    // The categories beside the kinds; Session is now a kind of its own.
    const others = offered.filter((type) => type !== "session");
    return (
      <header className="event-list-head">
        <h3>Events</h3>
        <details className="kind-filter event-type-filter">
          <summary>
            <span>Event kinds: all {kinds.length + others.length}</span>
            <ChevronDown aria-hidden="true" size={14} />
          </summary>
          <fieldset>
            <legend className="sr-only">Event kinds</legend>
            {kinds.map((kind) => (
              <label key={kind}>
                <input aria-label={kind} defaultChecked type="checkbox" />
                <KindLabel filter kind={kind} />
                <span className="event-type-count">{spikeCounts.get(kind)}</span>
              </label>
            ))}
            {others.map((type) => (
              <label key={type}>
                <input defaultChecked type="checkbox" />
                <span>{eventTypeLabel(type)}</span>
                <span className="event-type-count">{counts.get(type)}</span>
              </label>
            ))}
            <p className="event-type-filter-foot">
              <button type="button">Select all</button>
              <button type="button">Clear</button>
            </p>
          </fieldset>
        </details>
      </header>
    );
  }
  return (
    <header className="event-list-head">
      <h3>Events</h3>
      {offered.length > 0 && (
        <details className="kind-filter event-type-filter">
          <summary>
            <span>
              Event types:{" "}
              {shown === offered.length
                ? `all ${offered.length}`
                : `${shown} of ${offered.length}`}
            </span>
            <ChevronDown aria-hidden="true" size={14} />
          </summary>
          <fieldset>
            <legend className="sr-only">Event types</legend>
            {offered.map((type) => (
              <label key={type}>
                <input
                  aria-describedby={`${counted}-${type}`}
                  aria-label={eventTypeLabel(type)}
                  checked={!hidden.has(type)}
                  onChange={(event) =>
                    onHiddenChange(
                      event.target.checked
                        ? [...hidden].filter((other) => other !== type)
                        : [...hidden, type],
                    )
                  }
                  type="checkbox"
                />
                <span>{eventTypeLabel(type)}</span>
                <span className="event-type-count" id={`${counted}-${type}`}>
                  {counts.get(type) ?? 0}
                </span>
              </label>
            ))}
            <p className="event-type-filter-foot">
              <button onClick={() => onHiddenChange([])} type="button">
                Select all
              </button>
              <button
                onClick={() => onHiddenChange([...EVENT_TYPES])}
                type="button"
              >
                Clear
              </button>
            </p>
          </fieldset>
        </details>
      )}
    </header>
  );
}

/**
 * What a list shows when the reader's filter hid every row it holds: that the
 * filter is why, and the one control that puts every type back.
 */
export function FilteredEmpty({ onClear }: { readonly onClear: () => void }) {
  return (
    <div className="event-list-empty" role="status">
      <p>The event-type filter hides every event in this list.</p>
      <button className="load-earlier" onClick={onClear} type="button">
        Show every event type
      </button>
    </div>
  );
}

/**
 * One loop the run went round back to back: one pass through it, how many times
 * it went round, and the stretch of time it took, with the one control that opens
 * it into every row it stands for and closes it again.
 *
 * Named for what it holds, so a reader moving by landmark hears the loop and its
 * count before its rows; `aria-expanded` says which way the control goes.
 */
export function CycleBlock({
  entry,
  onToggle,
  children,
}: {
  readonly entry: Extract<TranscriptEntry, { entryKind: "cycle" }>;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const { group } = entry;
  const named = cycleLabel(group);
  return (
    <section
      aria-label={`${named}: ${group.displayLabel}`}
      className="transcript-cycle"
      data-cycle-count={group.count}
    >
      <header className="transcript-cycle-head">
        <Repeat2 aria-hidden="true" size={14} />
        <strong className="transcript-cycle-count">×{group.count}</strong>
        <span className="transcript-cycle-span">
          {named} · <Timestamp at={group.startedAt} />–
          <Timestamp at={group.endedAt ?? group.startedAt} />
          {group.durationMs !== null &&
            ` · ${formatDuration(group.durationMs)}`}
        </span>
        <button aria-expanded={entry.expanded} onClick={onToggle} type="button">
          {entry.expanded
            ? "Show one pass"
            : `Show all ${group.children.length}`}
        </button>
      </header>
      {children}
    </section>
  );
}
