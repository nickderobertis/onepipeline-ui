// SPIKE (throwaway, never lands): the event list grouped by turn, as the user
// approved it from a mockup. Every judge row is read back from the judge's own
// oneharness history (the journal records none), the supervisor is told from the
// verdict judge by which harness ran it, and the judge conversation's turn ids are
// computed from the order of its sessions. None of this is how the build should do it.
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import {
  Bot,
  Brain,
  ChevronRight,
  Gavel,
  type LucideIcon,
  MessageSquareText,
  Power,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TimelineRow } from "./timeline-model";

export type RowKind = "tool" | "message" | "reasoning" | "session";
export const ROW_KINDS: readonly RowKind[] = [
  "tool",
  "message",
  "reasoning",
  "session",
];
const KIND: Record<
  RowKind,
  { icon: LucideIcon; word: string; filter: string }
> = {
  tool: { icon: Wrench, word: "Tool", filter: "Tool call" },
  message: { icon: MessageSquareText, word: "Message", filter: "Message" },
  reasoning: { icon: Brain, word: "Reasoning", filter: "Reasoning" },
  session: { icon: Power, word: "Session", filter: "Session" },
};

export function KindLabel({
  kind,
  filter = false,
}: {
  readonly kind: RowKind;
  readonly filter?: boolean;
}) {
  const { icon: Icon, word, filter: long } = KIND[kind];
  return (
    <span className={`spike-kind spike-kind-${kind}`}>
      <Icon aria-hidden="true" className="size-3" />
      {filter ? long : word}
    </span>
  );
}

interface ListRow {
  readonly key: string;
  readonly kind: RowKind;
  readonly name?: string;
  readonly lead?: string;
  readonly mono?: string;
  readonly text?: string;
  readonly at?: string;
  /** What opening the row selects: an event row, or a judge turn and its item. */
  readonly open: {
    readonly id: string;
    readonly judgeTurn?: string;
    readonly eventIndex?: number;
  };
}

interface Group {
  readonly key: string;
  readonly role: "worker" | "supervisor" | "verdict" | "session";
  readonly turn: number;
  readonly historyId?: string;
  start?: string;
  end?: string;
  readonly rows: ListRow[];
  verdict?: { word: string; done: boolean };
}

interface Dispatch {
  readonly id: string;
  readonly label: string;
  readonly number: number;
  readonly groups: Group[];
  /** The judge session's row, which opens the judge conversation. */
  judgeSpan?: string;
  workerSpan?: string;
  judgeConversation?: string;
}

type Fields = Record<string, unknown>;
type HistoryTurn = {
  assistant?: string | null;
  durationMs?: number | null;
  timestamp?: string;
  agentEvents?: { index: number; kind: string; text: string }[];
  tools?: { index: number; name?: string | null; input?: unknown }[];
};

/** Which judge to open on: shared with the drawer, set by a judge row. */
export const spikeJudgeFocus: {
  current?: { turnId: string; eventIndex?: number };
} = {};

const SESSION_KINDS = new Set([
  "node-dispatched",
  "member-started",
  "member-settled",
  "retry-requested",
  "session-opened",
  "session-closed",
]);

function walk(
  rows: readonly TimelineRow[],
  dispatch: TimelineRow["dispatch"],
  out: { row: TimelineRow; dispatch: TimelineRow["dispatch"] }[],
) {
  for (const row of rows) {
    const at = row.dispatch ?? dispatch;
    out.push({ row, dispatch: at });
    walk(row.children, at, out);
  }
}

/** A tool call as one line: its name, then its description or its subject. */
export function toolLine(name: string | null | undefined, input: unknown) {
  const fields = (input ?? {}) as Fields;
  const command =
    typeof fields.command === "string"
      ? fields.command.replace(/^\/bin\/(ba)?sh -lc (['"])([\s\S]*)\2$/, "$3")
      : undefined;
  const shown = name === "command_execution" ? "Shell" : (name ?? "Tool");
  const lead =
    typeof fields.description === "string" ? fields.description : undefined;
  const subject =
    command ??
    (typeof fields.file_path === "string"
      ? fields.file_path
      : typeof fields.pattern === "string"
        ? fields.pattern
        : undefined);
  return { name: shown, lead, mono: subject };
}

/** A ruling's JSON, said as its sentence. */
export function rulingSentence(text: string | null | undefined) {
  if (!text) return undefined;
  try {
    const said = JSON.parse(text.slice(text.indexOf("{"))) as Fields;
    if ("completion" in said)
      return {
        done: said.completion === true,
        word: said.completion === true ? "done" : "not done",
        text: `${said.completion === true ? "Done" : "Not done"}: ${String(said.message ?? said.reason ?? "")}`,
      };
    if ("value" in said)
      return {
        done: said.value === true,
        word: said.value === true ? "criteria met" : "criteria not met",
        text: `${said.value === true ? "Criteria met" : "Criteria not met"}: ${String(said.reason ?? "")}`,
      };
  } catch {
    // not a ruling
  }
  return undefined;
}

function useHistories(
  client: TelemetryClient,
  runId: string,
  ids: readonly string[],
): ReadonlyMap<string, HistoryTurn> {
  const [read, setRead] = useState<ReadonlyMap<string, HistoryTurn>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(
      (key === "" ? [] : key.split(",")).map(async (id) => {
        try {
          const artifact = (await client.getArtifact(runId, id)) as {
            turns?: HistoryTurn[];
          };
          const first = artifact.turns?.[0];
          return first === undefined ? undefined : ([id, first] as const);
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (live)
        setRead(
          new Map(
            entries.filter((entry) => entry !== undefined) as [
              string,
              HistoryTurn,
            ][],
          ),
        );
    });
    return () => {
      live = false;
    };
  }, [key, client, runId]);
  return read;
}

function buildDispatches(tree: readonly TimelineRow[]): Dispatch[] {
  const flat: { row: TimelineRow; dispatch: TimelineRow["dispatch"] }[] = [];
  walk(tree, undefined, flat);
  const byId = new Map<string, Dispatch>();
  const events: { row: TimelineRow; dispatch: Dispatch }[] = [];
  for (const { row, dispatch } of flat) {
    if (dispatch === undefined) continue;
    let held = byId.get(dispatch.id);
    if (held === undefined) {
      held = {
        id: dispatch.id,
        label: dispatch.label,
        number: Number(dispatch.label.match(/\d+/)?.[0] ?? byId.size + 1),
        groups: [],
      };
      byId.set(dispatch.id, held);
    }
    if (
      row.rowKind === "span" &&
      row.transport !== "judge" &&
      row.role !== undefined
    )
      held.workerSpan ??= row.id;
    if (row.rowKind === "span" && row.transport === "judge") {
      held.judgeSpan ??= row.id;
      const reference = row.span.reference;
      if (reference?.kind === "conversation")
        held.judgeConversation ??= reference.value;
    }
    if (row.rowKind === "event") events.push({ row, dispatch: held });
  }
  events.sort(
    (a, b) => Date.parse(a.row.startedAt) - Date.parse(b.row.startedAt),
  );
  const current = new Map<string, Group>();
  const judgeSeen = new Map<string, number>();
  for (const { row, dispatch } of events) {
    if (row.rowKind !== "event") continue;
    const event = row.event;
    const fields = (event.fields ?? {}) as Fields;
    let session = dispatch.groups.find((group) => group.role === "session");
    if (session === undefined) {
      session = {
        key: `${dispatch.id}:session`,
        role: "session",
        turn: 0,
        rows: [],
        start: row.startedAt,
      };
      dispatch.groups.unshift(session);
    }
    if (SESSION_KINDS.has(event.kind)) {
      session.rows.push({
        key: row.id,
        kind: "session",
        text: event.kind,
        at: row.startedAt,
        open: { id: row.id },
      });
      continue;
    }
    if (event.kind === "oneharness-session") {
      const turn = Number(fields.turn ?? 0);
      const judge = fields.role === "judge";
      const verdict =
        judge && String(fields.identity ?? "").endsWith(":alternate");
      const group: Group = {
        key: `${dispatch.id}:${dispatch.groups.length}`,
        role: !judge ? "worker" : verdict ? "verdict" : "supervisor",
        turn,
        historyId: fields.history_id as string,
        start: row.startedAt,
        end: row.startedAt,
        rows: [],
      };
      if (judge) {
        const seen = judgeSeen.get(dispatch.id) ?? 0;
        judgeSeen.set(dispatch.id, seen + 1);
        (group as { judgeIndex?: number }).judgeIndex = seen;
      }
      dispatch.groups.push(group);
      current.set(dispatch.id, group);
      continue;
    }
    const group = current.get(dispatch.id);
    if (group === undefined) continue;
    group.end = row.endedAt ?? row.startedAt;
    if (event.kind !== "turn-activity") continue;
    if (fields.kind === "tool_result") continue;
    const kind: RowKind =
      fields.kind === "reasoning"
        ? "reasoning"
        : fields.kind === "message"
          ? "message"
          : "tool";
    group.rows.push({
      key: row.id,
      kind,
      text: row.displayLabel,
      at: row.startedAt,
      open: { id: row.id },
      ...(kind === "tool"
        ? {
            name: row.displayLabel.split(" ")[0],
            mono: row.displayLabel.split(" ").slice(1).join(" "),
            toolCallId: fields.tool_call_id,
            index: fields.index,
          }
        : { index: fields.index }),
    } as ListRow);
  }
  return [...byId.values()].sort((a, b) => b.number - a.number);
}

/** Fill each group from its history: the worker's tool lines, the judge's own rows. */
function withHistories(
  dispatches: Dispatch[],
  histories: ReadonlyMap<string, HistoryTurn>,
): Dispatch[] {
  for (const dispatch of dispatches) {
    const groups = dispatch.groups;
    groups.forEach((group, i) => {
      const read =
        group.historyId === undefined
          ? undefined
          : histories.get(group.historyId);
      const next = groups[i + 1]?.start;
      void next;
      if (
        group.role !== "worker" &&
        group.end === group.start &&
        read?.durationMs
      )
        group.end = new Date(
          Date.parse(group.start ?? "") + read.durationMs,
        ).toISOString();
      if (read === undefined) return;
      if (group.role === "worker") {
        for (const [j, row] of group.rows.entries()) {
          if (row.kind !== "tool") continue;
          const index = (row as unknown as { index?: number }).index;
          const tool = read.tools?.find((t) => t.index === index);
          if (tool)
            group.rows[j] = { ...row, ...toolLine(tool.name, tool.input) };
        }
        return;
      }
      if (group.role === "session") return;
      const judgeIndex = (group as { judgeIndex?: number }).judgeIndex ?? 0;
      const judgeTurn =
        dispatch.judgeConversation === undefined
          ? undefined
          : `${dispatch.judgeConversation}.${judgeIndex}`;
      const span = Date.parse(group.start ?? "");
      const length = Math.max(read.durationMs ?? 20_000, 1);
      const items = [
        ...(read.agentEvents ?? []).map((event) => ({
          index: event.index,
          kind: (event.kind === "reasoning"
            ? "reasoning"
            : "message") as RowKind,
          text: event.text,
        })),
        ...(read.tools ?? []).map((tool) => ({
          index: tool.index,
          kind: "tool" as RowKind,
          ...toolLine(tool.name, tool.input),
        })),
      ].sort((a, b) => a.index - b.index);
      const ruling = rulingSentence(read.assistant);
      const all = [
        ...items,
        {
          index: items.length + 1,
          kind: "message" as RowKind,
          text: ruling?.text ?? read.assistant ?? "",
        },
      ];
      group.rows.length = 0;
      all.forEach((item, j) => {
        group.rows.push({
          ...item,
          key: `${group.key}:${item.index}`,
          at: new Date(span + (length * (j + 0.5)) / all.length).toISOString(),
          open: {
            id: dispatch.judgeSpan ?? "",
            ...(judgeTurn === undefined ? {} : { judgeTurn }),
            ...(item.kind === "tool" ? { eventIndex: item.index } : {}),
          },
        });
      });
      group.end ??= new Date(span + length).toISOString();
      if (ruling) group.verdict = { word: ruling.word, done: ruling.done };
    });
  }
  return dispatches;
}

export function useGroupedDispatches(
  client: TelemetryClient,
  runId: string,
  tree: readonly TimelineRow[],
) {
  const base = useMemo(() => buildDispatches(tree), [tree]);
  const ids = useMemo(
    () =>
      base.flatMap((dispatch) =>
        dispatch.groups.flatMap((group) =>
          group.historyId === undefined ? [] : [group.historyId],
        ),
      ),
    [base],
  );
  const histories = useHistories(client, runId, ids);
  return useMemo(
    () => withHistories(buildDispatches(tree), histories),
    [tree, histories],
  );
}

export function kindCounts(dispatches: readonly Dispatch[]) {
  const counts = new Map<RowKind, number>();
  for (const dispatch of dispatches)
    for (const group of dispatch.groups)
      for (const row of group.rows)
        counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return counts;
}

const clock = (at?: string) =>
  at === undefined ? "" : new Date(at).toISOString().slice(11, 19);
function span(start?: string, end?: string) {
  if (start === undefined || end === undefined) return "";
  const seconds = Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000);
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
      : `${Math.round(seconds)}s`;
}

function title(group: Group) {
  return group.role === "session"
    ? "Session"
    : group.role === "worker"
      ? `Worker turn ${group.turn}`
      : group.role === "supervisor"
        ? `Judge ruling on turn ${group.turn}`
        : `Final verdict on turn ${group.turn}`;
}

const LIMIT = 8;

export function GroupedEventList({
  dispatches,
  onOpen,
  selectedItemId,
}: {
  readonly dispatches: readonly Dispatch[];
  readonly onOpen: (id: string) => void;
  readonly selectedItemId?: string;
}) {
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const [marked, setMarked] = useState<string>();
  // SPIKE capture hooks: open the group holding a row, and open a session by its span.
  useEffect(() => {
    const label = (row: ListRow) =>
      `Open ${[row.name, row.lead ?? row.mono ?? row.text].filter(Boolean).join(" ")}`;
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__spikeReveal = (start: string, nth = 0) => {
      const found = dispatches.flatMap((dispatch) =>
        dispatch.groups.flatMap((group) =>
          group.rows
            .filter((row) => label(row).startsWith(`Open ${start}`))
            .map((row) => ({ group, row })),
        ),
      )[nth];
      if (found === undefined) return undefined;
      setToggled((was) => new Map(was).set(found.group.key, true));
      setMore((was) => new Set(was).add(found.group.key));
      return found.row.key;
    };
    hooks.__spikeOpenSession = (dispatchNumber: number, judge: boolean) => {
      const dispatch = dispatches.find(
        ({ number }) => number === dispatchNumber,
      );
      const id = judge ? dispatch?.judgeSpan : dispatch?.workerSpan;
      spikeJudgeFocus.current = undefined;
      if (id !== undefined) onOpen(id);
      return id;
    };
  }, [dispatches, onOpen]);
  const newest = dispatches[0];
  const lastWorker =
    newest?.groups.findLastIndex((group) => group.role === "worker") ?? -1;
  const openByDefault = (dispatch: Dispatch, group: Group, index: number) =>
    (dispatch === newest && lastWorker >= 0 && index >= lastWorker) ||
    group.rows.some(
      (row) =>
        row.key === marked ||
        (marked === undefined &&
          row.open.id === selectedItemId &&
          !row.open.judgeTurn),
    );
  return (
    <div className="spike-grouped">
      {dispatches.map((dispatch) => {
        const turns = dispatch.groups.filter(
          (group) => group.role !== "session",
        ).length;
        return (
          <section
            aria-label={dispatch.label}
            className="spike-dispatch"
            key={dispatch.id}
          >
            <h3>
              {dispatch.label}
              <span className="spike-dispatch-meta">
                {clock(dispatch.groups[0]?.start)} · {turns} turns
              </span>
            </h3>
            {dispatch.groups.map((group, index) => {
              const open =
                toggled.get(group.key) ?? openByDefault(dispatch, group, index);
              const counts = ROW_KINDS.map(
                (kind) =>
                  [
                    kind,
                    group.rows.filter((row) => row.kind === kind).length,
                  ] as const,
              ).filter(([, n]) => n > 0);
              const shown = more.has(group.key)
                ? group.rows
                : group.rows.slice(0, LIMIT);
              const rest = group.rows.length - shown.length;
              const Icon =
                group.role === "worker" || group.role === "session"
                  ? Bot
                  : Gavel;
              return (
                <div className="spike-group" data-open={open} key={group.key}>
                  <button
                    aria-expanded={open}
                    className="spike-group-head"
                    onClick={() =>
                      setToggled((was) => new Map(was).set(group.key, !open))
                    }
                    type="button"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className="spike-chev size-3"
                    />
                    <Icon aria-hidden="true" className="spike-role size-3" />
                    <span className="spike-group-title">{title(group)}</span>
                    {group.verdict && (
                      <span
                        className={`spike-verdict ${group.verdict.done ? "is-done" : ""}`}
                      >
                        · {group.verdict.word}
                      </span>
                    )}
                    <span className="spike-counts">
                      {counts.map(([kind, n]) => {
                        const { icon: KindIcon } = KIND[kind];
                        return (
                          <span className={`spike-kind-${kind}`} key={kind}>
                            <KindIcon
                              aria-hidden="true"
                              className="size-[11px]"
                            />
                            {n}
                          </span>
                        );
                      })}
                    </span>
                    <span className="spike-group-meta">
                      {clock(group.start)}
                      {group.role === "session"
                        ? ""
                        : ` · ${span(group.start, group.end)}`}
                    </span>
                  </button>
                  {open && (
                    <div className="spike-tree">
                      {shown.map((row) => (
                        <button
                          aria-label={`Open ${[row.name, row.lead ?? row.mono ?? row.text].filter(Boolean).join(" ")}`}
                          data-row-key={row.key}
                          className={`spike-row ${row.key === marked || (marked === undefined && row.open.id === selectedItemId && !row.open.judgeTurn) ? "is-selected" : ""}`}
                          key={row.key}
                          onClick={() => {
                            setMarked(row.key);
                            spikeJudgeFocus.current =
                              row.open.judgeTurn === undefined
                                ? undefined
                                : {
                                    turnId: row.open.judgeTurn,
                                    ...(row.open.eventIndex === undefined
                                      ? {}
                                      : { eventIndex: row.open.eventIndex }),
                                  };
                            onOpen(row.open.id);
                          }}
                          type="button"
                        >
                          <KindLabel kind={row.kind} />
                          <span className="spike-row-text">
                            {row.name !== undefined && (
                              <span className="spike-row-name">{row.name}</span>
                            )}
                            {row.lead !== undefined && <span>{row.lead} </span>}
                            {row.mono !== undefined ? (
                              <span className="spike-row-mono">{row.mono}</span>
                            ) : row.name === undefined ? (
                              row.text
                            ) : null}
                          </span>
                          <span className="spike-row-time">
                            {clock(row.at)}
                          </span>
                        </button>
                      ))}
                      {rest > 0 && (
                        <button
                          className="spike-more"
                          onClick={() =>
                            setMore((was) => new Set(was).add(group.key))
                          }
                          type="button"
                        >
                          Show {rest} more
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
