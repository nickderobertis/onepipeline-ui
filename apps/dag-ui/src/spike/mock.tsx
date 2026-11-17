/**
 * SPIKE (spike-visual, never lands): the hard-coded mock of the DAG UI
 * readability plan's visible changes. Throwaway: no tests, no lint.
 */
import {
  Bot,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  CircleX,
  GitBranch,
  Hand,
  LoaderCircle,
  type LucideIcon,
  OctagonMinus,
  Repeat2,
  Shapes,
  SquareTerminal,
  Unplug,
  UserRound,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type {
  TimelineRow,
  TranscriptEntry,
} from "../features/timeline/timeline-model";

export interface Cycle {
  readonly entryKind: "cycle";
  readonly id: string;
  readonly pass: readonly TimelineRow[];
  readonly rows: readonly TimelineRow[];
  readonly count: number;
  readonly first: number;
  readonly last: number;
}

const key = (row: TimelineRow) => `${row.displayKind}|${row.displayLabel}`;

/** Any back-to-back repeat of one or more rows, longest saving first. */
export function collapseCycles(
  entries: readonly TranscriptEntry[],
): (TranscriptEntry | Cycle)[] {
  const out: (TranscriptEntry | Cycle)[] = [];
  let i = 0;
  while (i < entries.length) {
    let best: { length: number; count: number } | undefined;
    for (let length = 1; i + 2 * length <= entries.length; length += 1) {
      const block = entries.slice(i, i + length);
      if (block.some((entry) => entry.entryKind !== "row")) break;
      const keys = block.map((entry) =>
        entry.entryKind === "row" ? key(entry.row) : "",
      );
      let count = 1;
      while (
        i + (count + 1) * length <= entries.length &&
        entries
          .slice(i + count * length, i + (count + 1) * length)
          .every(
            (entry, at) =>
              entry.entryKind === "row" && key(entry.row) === keys[at],
          )
      )
        count += 1;
      if (
        count >= 2 &&
        (best === undefined ||
          (count - 1) * length > (best.count - 1) * best.length)
      )
        best = { length, count };
    }
    if (best === undefined) {
      out.push(entries[i] as TranscriptEntry);
      i += 1;
      continue;
    }
    const rows = entries
      .slice(i, i + best.length * best.count)
      .flatMap((entry) => (entry.entryKind === "row" ? [entry.row] : []));
    const ends = rows.map(
      (row) => Date.parse(row.startedAt) + (row.durationMs ?? 0),
    );
    out.push({
      entryKind: "cycle",
      id: `cycle-${rows[0]?.id}`,
      pass: rows.slice(0, best.length),
      rows,
      count: best.count,
      first: Date.parse(rows[0]?.startedAt ?? ""),
      last: Math.max(...ends),
    });
    i += best.length * best.count;
  }
  return out;
}

/** One row per surface: queued and surfaced join, with the surface's status. */
export function oneRowPerSurface(
  entries: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const seen = new Map<string, number>();
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.entryKind === "row" && /surface/iu.test(entry.row.displayKind)) {
      const at = seen.get(entry.row.displayLabel);
      if (at !== undefined) {
        const was = out[at];
        if (was?.entryKind === "row")
          out[at] = {
            entryKind: "row",
            row: {
              ...was.row,
              status: `waiting for a reply · read ${clock(Date.parse(entry.row.startedAt))}`,
            } as TimelineRow,
          };
        continue;
      }
      seen.set(entry.row.displayLabel, out.length);
      out.push({
        entryKind: "row",
        row: { ...entry.row, status: "queued" } as TimelineRow,
      });
      continue;
    }
    out.push(entry);
  }
  return out;
}

export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export function spanWords(first: number, last: number): string {
  const minutes = Math.round((last - first) / 60_000);
  return `${clock(first)}–${clock(last)} · ${minutes} min`;
}

export function CycleBlock({
  cycle,
  children,
}: {
  readonly cycle: Cycle;
  readonly children: (rows: readonly TimelineRow[]) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label={`Repeated ${cycle.count} times`}
      className="spike-cycle"
    >
      <header className="spike-cycle-head">
        <Repeat2 aria-hidden="true" size={14} />
        <strong className="spike-cycle-count">×{cycle.count}</strong>
        <span>
          {cycle.pass.length} events repeated {cycle.count} times ·{" "}
          {spanWords(cycle.first, cycle.last)}
        </span>
        <button
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? "Show one pass" : `Show all ${cycle.rows.length}`}
        </button>
      </header>
      {children(open ? cycle.rows : cycle.pass)}
    </section>
  );
}

/** The event-type vocabulary the filter offers, one type per row. */
export function eventType(row: TimelineRow): string {
  const kind = row.rowKind === "event" ? row.event.kind : row.kind;
  if (/surface/iu.test(row.displayKind) || /surface|replied/u.test(kind))
    return "Surfaces and replies";
  if (/held|queued/u.test(kind)) return "Holds and queue";
  if (/^turn-|activity/u.test(kind) || row.rowKind === "span")
    return "Agent turns";
  if (/command/u.test(kind)) return "Commands";
  if (/human|attest/u.test(kind)) return "Human answers";
  if (/edit|note|context/u.test(kind)) return "Edits and notes";
  if (/gate|verif|check|push|pr|publication/u.test(kind))
    return "Checks and publication";
  return "Lifecycle";
}

export const EVENT_TYPES = [
  "Lifecycle",
  "Holds and queue",
  "Agent turns",
  "Surfaces and replies",
  "Commands",
  "Human answers",
  "Edits and notes",
  "Checks and publication",
];

export function EventTypeFilter({
  counts,
}: {
  readonly counts: ReadonlyMap<string, number>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="spike-filter">
      <button
        aria-expanded={open}
        className="spike-filter-button"
        onClick={() => setOpen(!open)}
        type="button"
      >
        Event types: all {EVENT_TYPES.length}
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open && (
        <fieldset aria-label="Event types" className="spike-filter-menu">
          <legend className="sr-only">Event types</legend>
          {EVENT_TYPES.map((type) => (
            <label key={type}>
              <input defaultChecked type="checkbox" />
              <span>{type}</span>
              <span className="spike-filter-count">{counts.get(type) ?? 0}</span>
            </label>
          ))}
          <p className="spike-filter-foot">
            <button type="button">Select all</button>
            <button type="button">Clear</button>
          </p>
        </fieldset>
      )}
    </div>
  );
}

/** One shell-quoted command line. */
export function commandLine(argv: readonly string[]): string {
  return argv
    .map((arg) =>
      arg === ""
        ? "''"
        : /^[A-Za-z0-9_@%+=:,./-]+$/u.test(arg)
          ? arg
          : `'${arg.replaceAll("'", `'"'"'`)}'`,
    )
    .join(" ");
}

/** `<repo>#<number>` for a change request URL, or a readable fallback. */
export function changeId(url: string): string {
  const github = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/u.exec(url);
  if (github) return `${github[1]}#${github[2]}`;
  const number = /(\d+)\/?$/u.exec(url);
  // SPIKE: the fixture's change URLs are not GitHub's, so the repo is hard-coded.
  return number ? `widgets#${number[1]}` : "Change request";
}

export const spikePartial = () =>
  typeof window !== "undefined" &&
  window.localStorage.getItem("spike-partial") === "1";

/** `transcriptRuns`, over entries that may be cycles. */
export function spikeRuns(entries: readonly (TranscriptEntry | Cycle)[]) {
  const runs: {
    id: string;
    dispatch?: { readonly id: string; readonly label: string };
    entries: (TranscriptEntry | Cycle)[];
  }[] = [];
  for (const entry of entries) {
    const subject =
      entry.entryKind === "cycle"
        ? undefined
        : entry.entryKind === "row"
          ? entry.row
          : entry.group;
    const open = runs.at(-1);
    if (
      subject?.dispatch !== undefined &&
      open?.dispatch !== undefined &&
      open.dispatch.id === subject.dispatch.id
    )
      open.entries.push(entry);
    else if (subject === undefined || subject.dispatch === undefined) {
      if (open !== undefined && open.dispatch === undefined)
        open.entries.push(entry);
      else
        runs.push({
          id: entry.entryKind === "cycle" ? entry.id : (subject?.id ?? ""),
          entries: [entry],
        });
    } else
      runs.push({ id: subject.id, dispatch: subject.dispatch, entries: [entry] });
  }
  return runs;
}

/** SPIKE: the run's display title, hard-coded for the long-title fixture run (160 characters). */
export const SPIKE_TITLE =
  "Make the DAG UI readable at a glance and complete on drill-in, with compact event lists, a readable chart, answerable approval items and the run details on view";
export const spikeTitle = (runId: string | undefined) =>
  runId?.startsWith("make-the-dag-ui-readable") ? SPIKE_TITLE : runId;

/**
 * Revision 2: one run state, derived from the driver's word (`run.state`, the
 * status route's `liveness`) and the graph's node statuses, shown once.
 */
export interface OneRunState {
  readonly word: string;
  readonly Icon: LucideIcon;
  readonly tone: string;
}

const TONES = {
  success: "border-success bg-success-surface text-success",
  destructive: "border-destructive bg-destructive-surface text-destructive",
  warning: "border-warning bg-warning-surface text-warning",
  info: "border-info bg-info-surface text-info",
  muted: "border-border bg-muted text-muted-foreground",
} as const;

export function oneRunState(
  state: string | undefined,
  liveness: string | undefined,
  nodeStatus: Readonly<Record<string, string>> | undefined,
): OneRunState | undefined {
  const s = (state ?? "").toLowerCase().replaceAll(" ", "-");
  const l = (liveness ?? "").toUpperCase().replaceAll("-", " ");
  const statuses = Object.values(nodeStatus ?? {});
  if (s === "settled" || s === "complete")
    return { word: "Complete", Icon: CircleCheck, tone: TONES.success };
  if (s === "ended-failed" || s === "failed")
    return { word: "Failed", Icon: CircleX, tone: TONES.destructive };
  if (s === "ended-stopped")
    return { word: "Stopped", Icon: OctagonMinus, tone: TONES.muted };
  // Not placed among the seven words: nothing failed, nothing left to decide.
  if (s === "ended-unfinished")
    return { word: "Unfinished", Icon: CircleSlash, tone: TONES.warning };
  if (s === "paused")
    return { word: "Waiting on you", Icon: Hand, tone: TONES.warning };
  if (l === "DRIVER DEAD" || l === "UNDRIVEN" || s === "driver-dead" || s === "undriven")
    return { word: "Driver dead", Icon: Unplug, tone: TONES.destructive };
  if (l === "PARKED" || s === "parked")
    return { word: "Paused", Icon: CirclePause, tone: TONES.muted };
  if (l === "ACTIVE" || s === "active" || s === "running") {
    if (statuses.includes("waiting"))
      return { word: "Waiting on you", Icon: Hand, tone: TONES.warning };
    return { word: "Running", Icon: LoaderCircle, tone: TONES.info };
  }
  return state === undefined && liveness === undefined
    ? undefined
    : { word: state ?? liveness ?? "", Icon: CircleDashed, tone: TONES.muted };
}

export function RunStateBadge({
  runState,
  large = false,
}: {
  readonly runState: OneRunState | undefined;
  readonly large?: boolean;
}) {
  if (runState === undefined) return null;
  const { Icon, word, tone } = runState;
  return (
    <span
      aria-label={`Run state ${word}`}
      className={`spike-run-state inline-flex items-center gap-1.5 rounded-md border font-semibold whitespace-nowrap ${tone} ${large ? "px-2.5 py-1 text-sm" : "px-2 py-0.5 text-xs"}`}
      role="status"
    >
      <Icon aria-hidden="true" size={large ? 16 : 13} />
      {word}
    </span>
  );
}

/**
 * Revision 5 (and ruling c5.0): the pill's word and icon. A node naming a `repo`
 * or `steps` (today's `lifecycle`) reads CHANGE, `kind: command` COMMAND,
 * `kind: human` HUMAN, and every other node AGENT.
 */
export const kindWord = (kind: string): string =>
  kind === "lifecycle"
    ? "change"
    : kind === "command" || kind === "human"
      ? kind
      : "agent";

const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  agent: Bot,
  human: UserRound,
  command: SquareTerminal,
  change: GitBranch,
};

export function KindIcon({ kind }: { readonly kind: string }) {
  const Icon = KIND_ICONS[kind] ?? Shapes;
  return <Icon aria-label={kind} role="img" size={10} strokeWidth={2.4} />;
}
