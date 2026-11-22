// SPIKE (throwaway, never lands): the conversation-focus mock. Hard-coded DOM
// placement standing in for what the plan's contracts would compute: find the
// clicked item in the rendered conversation, light it, and put its top directly
// below the sticky Turns/Tools card.
import type { TimelineRow } from "@onepipeline-ui/dag-model";

type Target = { turn: number; part: "prompt" | "answer" | "end" | "tool" | "reasoning"; toolCallId?: string; text?: string };

const fieldsOf = (row: TimelineRow): Record<string, unknown> =>
  row.rowKind === "event" ? ((row.event.fields ?? {}) as Record<string, unknown>) : {};

/** Which item of which turn (1-based, in rendered order) a row opens at. */
export function spikeTarget(row: TimelineRow, turnTexts: readonly { user: string; reasoning: readonly string[]; tools: readonly string[] }[]): Target | undefined {
  if (row.rowKind === "span") return { turn: 1, part: "prompt" };
  const event = row.event;
  const fields = fieldsOf(row);
  const turnNo = typeof fields.turn === "number" ? fields.turn : undefined;
  const label = row.displayLabel;
  const supervisor = (row as { member?: string }).member === "supervisor" || /supervisor/.test(JSON.stringify(event.labels ?? {}));
  if (supervisor && event.kind === "turn-message") {
    const said = typeof fields.text === "string" ? fields.text : label;
    const at = turnTexts.findIndex((t) => t.user.trim() === said.trim());
    return { turn: at < 0 ? 1 : at + 1, part: "prompt" };
  }
  if (supervisor && event.kind === "turn-started") return { turn: Math.max(1, Math.floor(((turnNo ?? 1) + 1 - 1) / 8)), part: "prompt" };
  if (event.kind === "oneharness-session") return { turn: 1, part: "prompt" };
  if (event.kind === "turn-started" && turnNo) return { turn: turnNo, part: "prompt" };
  if (event.kind === "turn-message" && turnNo) return { turn: turnNo, part: "answer" };
  if (event.kind === "turn-completed" && turnNo) return { turn: turnNo, part: "end" };
  if (event.tool?.tool_call_id) {
    const at = turnTexts.findIndex((t) => t.tools.includes(event.tool?.tool_call_id ?? ""));
    if (at >= 0) return { turn: at + 1, part: "tool", toolCallId: event.tool.tool_call_id };
  }
  const reasoned = turnTexts.findIndex((t) => t.reasoning.some((r) => r.startsWith(label.replace(/…$/, ""))));
  if (reasoned >= 0) return { turn: reasoned + 1, part: "reasoning", text: label };
  return undefined;
}

/** Whether the opened row belongs to the supervisor, and so opens another conversation. */
export function spikeRedirect(row: TimelineRow, conversationId: string | undefined): string | undefined {
  if (conversationId === undefined || row.rowKind !== "event") return conversationId;
  if (!conversationId.endsWith(".supervisor")) return conversationId;
  if (row.event.kind === "turn-message") return conversationId.replace(/\.supervisor$/, ".worker");
  if (row.event.kind === "turn-started") return conversationId.replace(/\.supervisor$/, ".judge");
  return conversationId;
}

function scrollerOf(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
}

/** Light `target` in `root` and put it just below the sticky card. */
export function spikeApply(root: HTMLElement, target: Target): void {
  const turns = root.querySelectorAll<HTMLElement>("article[data-turn-id]");
  const turn = turns[target.turn - 1];
  if (!turn) return;
  let element: HTMLElement | null = null;
  if (target.part === "prompt") element = turn.querySelector<HTMLElement>('[aria-label="User message"]')?.closest<HTMLElement>(".rounded-\\[22px_22px_5px_22px\\]") ?? null;
  if (target.part === "answer") element = turn.querySelector<HTMLElement>('[aria-label="Assistant message"]');
  if (target.part === "end") element = turn.querySelector<HTMLElement>('dl[aria-label="Usage"]');
  if (target.part === "tool") element = turn.querySelector<HTMLElement>(`[data-tool-call-id="${target.toolCallId}"]`);
  if (target.part === "reasoning") {
    const triggers = [...turn.querySelectorAll<HTMLElement>("button")].filter((b) => b.textContent?.trim() === "Reasoning");
    for (const trigger of triggers) if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    element = [...turn.querySelectorAll<HTMLElement>(".border-dashed")].find((e) => e.textContent?.includes(target.text?.replace(/…$/, "").slice(0, 30) ?? "\u0000")) ?? null;
    for (const trigger of triggers) if (!element?.contains(trigger)) trigger.click();
  }
  root.querySelectorAll(".spike-focus").forEach((e) => e.classList.remove("spike-focus"));
  root.querySelectorAll('[aria-current="true"]').forEach((e) => e.removeAttribute("aria-current"));
  if (!element) return;
  element.classList.add("spike-focus");
  element.setAttribute("aria-current", "true");
  const scroller = scrollerOf(element);
  const sticky = root.querySelector<HTMLElement>(".conversation-timeline-sticky");
  if (!scroller) return;
  const below = scroller.getBoundingClientRect().top + (sticky?.offsetHeight ?? 0);
  scroller.scrollTop += element.getBoundingClientRect().top - below - 8;
}
