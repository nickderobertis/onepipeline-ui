import type {
  HumanItemBatchAnswer,
  HumanItemRefusal,
} from "@onepipeline-ui/dag-model";
import { z } from "zod";

/**
 * An answer not yet sent: a choice, the person's words, or both. It carries the
 * item's title and the choice's as they read when drafted, so a draft whose item
 * can no longer be read can still say what it was.
 */
export interface Draft {
  readonly title: string;
  readonly choice?: string;
  readonly choiceTitle?: string;
  readonly text?: string;
}

export type Drafts = Readonly<Record<string, Draft>>;

/** A draft that did not go out and whose item takes no answer any more. */
export interface NotSent extends Draft {
  readonly key: number;
  readonly reason: string;
}

/** The engine's limit on one batch (`MAX_BATCH_ANSWERS`). */
export const MAX_BATCH_ANSWERS = 50;

/** Why a draft is gone when the page learned it from the list, not a refusal. */
export const ELSEWHERE = "answered or dismissed elsewhere";

/** Every drafted item has its own key, so tabs never overwrite each other's. */
const KEY_PREFIX = "onepipeline-ui.human-items.draft.";

const storedDraft: z.ZodType<Draft> = z.strictObject({
  title: z.string(),
  choice: z.string().optional(),
  choiceTitle: z.string().optional(),
  text: z.string().optional(),
});

/** What this browser holds, or `undefined` where its storage cannot be read. */
export function storedDrafts(): Drafts | undefined {
  try {
    const held: Record<string, Draft> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null || !key.startsWith(KEY_PREFIX)) continue;
      const draft = readDraft(window.localStorage.getItem(key));
      if (draft !== undefined) held[key.slice(KEY_PREFIX.length)] = draft;
    }
    return held;
  } catch {
    return undefined;
  }
}

/** Storage is another writer's as much as ours: what it holds is only used if valid. */
function readDraft(stored: string | null): Draft | undefined {
  if (stored === null) return undefined;
  try {
    const parsed = storedDraft.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function storeDraft(id: string, draft: Draft | undefined): void {
  try {
    if (draft === undefined)
      window.localStorage.removeItem(`${KEY_PREFIX}${id}`);
    else
      window.localStorage.setItem(`${KEY_PREFIX}${id}`, JSON.stringify(draft));
  } catch {
    // A browser that keeps nothing still holds the draft for this visit.
  }
}

function nonblank(text: string | undefined): text is string {
  return text !== undefined && text.trim() !== "";
}

/** Whether a draft says anything the engine would take as an answer. */
export function isSendable(draft: Draft): boolean {
  return draft.choice !== undefined || nonblank(draft.text);
}

/** The batch entry a sendable draft becomes; blank words are no words. */
export function batchEntry(id: string, draft: Draft): HumanItemBatchAnswer {
  return {
    id,
    ...(draft.choice === undefined ? {} : { choice: draft.choice }),
    ...(nonblank(draft.text) ? { text: draft.text } : {}),
  };
}

/** The engine's words for why it refused one entry. */
export function refusalReason(refusal: HumanItemRefusal): string {
  return refusal.kind === "conflict"
    ? refusal.reason
    : "human items are unavailable on this host";
}
