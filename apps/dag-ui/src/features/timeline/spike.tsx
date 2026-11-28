// SPIKE (throwaway, never lands): the judge-turns / event-kinds visual mock.
// Hard-coded labels, colours and a judge-history lookup by the fixture's own id
// scheme; nothing here is how the build should do it.
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import {
  Brain,
  Gavel,
  type LucideIcon,
  MessageSquareText,
  Power,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { TimelineEvent } from "@onepipeline-ui/dag-model";

export const SPIKE_KINDS = [
  "Tool call",
  "Agent message",
  "Reasoning",
  "Turn",
  "Judge",
  "Session lifecycle",
] as const;
export type SpikeKind = (typeof SPIKE_KINDS)[number];

const LOOK: Record<SpikeKind, { icon: LucideIcon; tone: string; short: string }> = {
  "Tool call": { icon: Wrench, tone: "tool", short: "Tool" },
  "Agent message": { icon: MessageSquareText, tone: "message", short: "Message" },
  Reasoning: { icon: Brain, tone: "reasoning", short: "Reasoning" },
  Turn: { icon: RefreshCw, tone: "turn", short: "Turn" },
  Judge: { icon: Gavel, tone: "judge", short: "Judge" },
  "Session lifecycle": { icon: Power, tone: "lifecycle", short: "Session" },
};

const LIFECYCLE = new Set([
  "member-started",
  "member-settled",
  "node-dispatched",
  "session-opened",
  "session-closed",
]);

/** What one journal record is, as a reader would name it. */
export function spikeKind(event: TimelineEvent): SpikeKind | undefined {
  const fields = (event.fields ?? {}) as Record<string, unknown>;
  const role = fields.role;
  switch (event.kind) {
    case "turn-activity":
      return fields.kind === "reasoning"
        ? "Reasoning"
        : fields.kind === "message"
          ? "Agent message"
          : "Tool call";
    case "turn-started":
    case "turn-completed":
      return role === "user" ? "Judge" : "Turn";
    case "turn-message":
      return role === "user" ? "Judge" : "Agent message";
    case "oneharness-session":
      return role === "judge" ? "Judge" : "Session lifecycle";
    default:
      return LIFECYCLE.has(event.kind) ? "Session lifecycle" : undefined;
  }
}

export function SpikeKindBadge({ kind }: { readonly kind: SpikeKind }) {
  const { icon: Icon, tone, short } = LOOK[kind];
  return (
    <span className={`spike-kind spike-kind-${tone}`} title={kind}>
      <Icon aria-hidden="true" className="size-3" />
      {short}
    </span>
  );
}

/** The fixture's judge history ids: kind 5 a supervisor turn, 6 the verdict judge. */
const historyId = (kind: number, n: number) =>
  `01a19000-0000-7000-8000-${String(kind * 1000 + n).padStart(12, "0")}`;

export type JudgeTurnKind = "Supervisor" | "Verdict judge" | "Conclusion";

/** Which judge a served judge turn is, read off its attribution and status. */
export function judgeTurnKind(turn: {
  readonly status?: string | null;
  readonly unknown?: unknown;
}): { kind: JudgeTurnKind; index?: number } {
  if (turn.status === "member-settled") return { kind: "Conclusion" };
  const attribution = (turn.unknown as { attribution?: { turn_index?: number; ran?: string } })
    ?.attribution;
  const index = attribution?.turn_index ?? 0;
  return attribution?.ran === "codex:alternate"
    ? { kind: "Verdict judge" }
    : { kind: "Supervisor", index };
}

type ArtifactTurn = {
  user?: string;
  assistant?: string | null;
  tools?: unknown[];
  agentEvents?: unknown[];
  reasoning?: unknown;
};

/** The judge turns' own histories, read the way an oneharness session is read. */
export function useJudgeHistories(
  client: TelemetryClient,
  runId: string,
  conversationId: string | undefined,
  turns: readonly { id: string; status?: string | null; unknown?: unknown }[],
): ReadonlyMap<string, ArtifactTurn> {
  const [read, setRead] = useState<ReadonlyMap<string, ArtifactTurn>>(new Map());
  const judge = conversationId?.endsWith(".judge") === true;
  const key = turns.map((turn) => turn.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: spike
  useEffect(() => {
    if (!judge) return;
    let live = true;
    void Promise.all(
      turns.map(async (turn) => {
        const { kind, index } = judgeTurnKind(turn);
        if (kind === "Conclusion") return undefined;
        // The fixture's kinds per judged dispatch: the first 5/6, the third 12/13.
        const [sup, ver] = conversationId?.startsWith(THIRD_DISPATCH) ? [12, 13] : [5, 6];
        const id =
          kind === "Supervisor" ? historyId(sup, index ?? 0) : historyId(ver, 1);
        try {
          const artifact = (await client.getArtifact(runId, id)) as {
            turns?: ArtifactTurn[];
          };
          const first = artifact.turns?.[0];
          return first === undefined ? undefined : ([turn.id, first] as const);
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (live)
        setRead(
          new Map(entries.filter((entry) => entry !== undefined) as [string, ArtifactTurn][]),
        );
    });
    return () => {
      live = false;
    };
  }, [judge, key, client, runId]);
  return read;
}

/** The concluding turn's verdicts and reason, as text. */
export function conclusionText(unknown: unknown): string {
  const { verdicts = [], completionReason } = (unknown ?? {}) as {
    verdicts?: { criterion: string; value: unknown; reason?: string }[];
    completionReason?: string;
  };
  const lines = verdicts.map(
    (verdict) =>
      `- **${verdict.value === true ? "✓ Met" : "✗ Not met"}** — ${verdict.criterion}\n  ${verdict.reason ?? ""}`,
  );
  return [
    `**Verdicts on ${verdicts.length} criteria**`,
    "",
    ...lines,
    "",
    `**Completion reason:** ${completionReason ?? "none recorded"}`,
  ].join("\n");
}

/** A judge's JSON answer, said as words. */
export function judgeText(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) return undefined;
  const at = text.lastIndexOf("{");
  try {
    const said = JSON.parse(text.slice(at)) as {
      completion?: boolean;
      message?: string;
      value?: unknown;
      reason?: string;
    };
    const before = text.slice(0, at).trim();
    const lead = before === "" ? "" : `${before}\n\n`;
    if ("completion" in said)
      return `${lead}**${said.completion ? "Done:" : "Not done:"}** ${said.message ?? ""}`;
    if ("value" in said)
      return `${lead}**${said.value === true ? "Criteria met:" : "Criteria not met:"}** ${said.reason ?? ""}`;
  } catch {
    // not JSON: shown as written
  }
  return text;
}

/** SPIKE: the fixture's judged, settled dispatch, whose worker turns link to their judge. */
export const JUDGED_DISPATCH = "node-scope-1794000000000-5100.";
/** SPIKE: the third, judged dispatch the grouped list opens on. */
export const THIRD_DISPATCH = "node-scope-1794000000003-5103.";
