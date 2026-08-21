import { Badge } from "@oneharness/ui";
import { Timestamp } from "../../lib/Timestamp";
import { formatDuration, formatTimestamp } from "../../lib/time";
import { EventCategoryIcon, eventCategoryLabel } from "./event-category";
import type { TimelineRow } from "./timeline-model";

/**
 * What one timeline record says about itself, and the two surfaces that say it.
 *
 * A reader meets the same record twice: as the heading the detail panel opens it
 * under, and — for a journal record — as the reading its marker answers a hover with.
 * Both are composed here, off one set of facts, because the alternative is two
 * accounts of one record that agree only for as long as nobody edits one of them.
 */

/** A journal record: the only kind of row the plot draws as a marker. */
type EventRow = Extract<TimelineRow, { readonly rowKind: "event" }>;

/** The facts a record is identified by, read once for both presentations below. */
interface ItemReading {
  readonly kind: string;
  readonly label: string;
  readonly startedAt: string;
  /** Absent where the record closed no interval, which is every journal record. */
  readonly duration?: string;
  /** Only ever true of a span the recorded stream never closed. */
  readonly running: boolean;
  readonly status?: string;
}

function itemReading(row: TimelineRow): ItemReading {
  return {
    kind: row.displayKind,
    label: row.displayLabel,
    startedAt: row.startedAt,
    ...(row.durationMs === null
      ? {}
      : { duration: formatDuration(row.durationMs) }),
    running: row.endedAt === null && row.rowKind === "span",
    ...(row.status ? { status: row.status } : {}),
  };
}

/** The heading the detail panel opens a record under. */
export function ItemHeading({ row }: { readonly row: TimelineRow }) {
  const reading = itemReading(row);
  return (
    <header className="detail-title">
      <div>
        {/* The category the operator already read in the lane and the transcript,
            never the served identifier behind it. */}
        <Badge className="mb-1" variant="outline">
          {reading.kind}
        </Badge>
        <h2>{reading.label}</h2>
        <p className="detail-when">
          <Timestamp at={reading.startedAt} />
          {reading.duration !== undefined && ` · ${reading.duration}`}
          {reading.running && " · still running"}
        </p>
      </div>
      {reading.status !== undefined && (
        <Badge variant="secondary">{reading.status}</Badge>
      )}
    </header>
  );
}

/**
 * The same facts as one line, plus the category the glyph beside it was drawn from —
 * which is the one thing a marker shows that its heading shows only as a picture.
 */
function markerLine(row: EventRow): string {
  const reading = itemReading(row);
  return [
    reading.kind,
    reading.label,
    formatTimestamp(reading.startedAt),
    eventCategoryLabel(row.category),
    reading.status,
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" · ");
}

/**
 * A marker's glyph, carrying the reading `TimelinePopover` paints when it is hovered.
 *
 * The package draws a marker as a button with an `aria-label` and whatever this slot
 * returns — no description element, no `title` — so the reading has to travel on the
 * glyph itself. It travels as an attribute rather than as text inside the button
 * because the button's own label already names the record to a screen reader, and a
 * second copy of it in the content would be that record announced twice. `title` is
 * out for that reason and for one more: the browser would paint its own tooltip
 * beside the one this app places, in the corner of the screen this app placed it to
 * avoid.
 *
 * The wrapper fills the button, so the reading answers anywhere on the hit target
 * rather than only over the drawing inside it.
 */
export function MarkerReading({ row }: { readonly row: EventRow }) {
  return (
    <span
      className="timeline-marker-reading"
      data-timeline-reading={markerLine(row)}
    >
      <EventCategoryIcon category={row.category} />
    </span>
  );
}

/** Where the reading above is hung, and the only place it is looked for. */
const HUNG = "data-timeline-reading";

/**
 * The marker reading an event landed on, and the element it is hung on.
 *
 * Looked for in both directions, because the two ways of arriving at a marker land on
 * different elements: a pointer enters the glyph the reading is hung on, while focus
 * lands on the package's button *around* it — and that button is the package's to
 * render, so nothing here can be hung on it. The search downwards is bounded to that
 * button rather than run from wherever the event landed, because a pointer also
 * enters the plot holding every marker, and the first reading inside *that* is some
 * other record's.
 */
export function markerReadingAt(
  target: Element,
): { readonly element: HTMLElement; readonly detail: string } | undefined {
  const entered = target.closest(`[${HUNG}]`);
  const element =
    entered ?? target.closest("button")?.querySelector(`[${HUNG}]`);
  if (!(element instanceof HTMLElement)) return undefined;
  const detail = element.getAttribute(HUNG)?.trim();
  return detail === undefined || detail.length === 0
    ? undefined
    : { element, detail };
}
