import type {
  HumanItemChoice,
  HumanItemReceipt,
  HumanItemView,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { TelemetryClientError } from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  batchEntry,
  type Draft,
  type Drafts,
  ELSEWHERE,
  isSendable,
  MAX_BATCH_ANSWERS,
  type NotSent,
  refusalReason,
  storeDraft,
  storedDrafts,
} from "./human-item-drafts";

/** Whether an item no longer takes an answer, or `undefined` if that is unknown. */
async function noLongerOpen(
  client: TelemetryClient,
  id: string,
): Promise<boolean | undefined> {
  try {
    return (await client.getHumanItem(id)).item.state !== "open";
  } catch (error) {
    if (error instanceof TelemetryClientError && error.status === 404)
      return true;
    return undefined;
  }
}

function without<T>(all: Readonly<Record<string, T>>, id: string) {
  if (all[id] === undefined) return all;
  return Object.fromEntries(
    Object.entries(all).filter(([held]) => held !== id),
  );
}

/**
 * The answers this browser holds unsent, and sending them as one batch.
 *
 * A draft lives in `localStorage` until it is sent or discarded. One whose item
 * stops being open leaves storage and becomes a "Not sent" notice held in page
 * memory: the words are never lost unseen, and never sent to nothing. An item
 * a filter merely hides is still open, so absence from the list is only a reason
 * to ask the server, once per filter.
 *
 * Other tabs are deliberately not followed live: this tab's drafts are the ones
 * it shows, and a send re-reads storage so a draft another tab sent or discarded
 * does not go out from here as well.
 */
export function useAnswerDrafts(
  client: TelemetryClient,
  /** What the server last said the list holds; `undefined` until it has. */
  listed: readonly HumanItemView[] | undefined,
  /** The list's filter: what a hidden item was found open under stands until it changes. */
  filterKey: string,
  /** Whether a write the page itself made is out for this item. */
  writing: (id: string) => boolean,
  onAnswered: (receipts: readonly HumanItemReceipt[]) => void,
) {
  const [drafts, setDrafts] = useState<Drafts>(() => storedDrafts() ?? {});
  const [refusals, setRefusals] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [notices, setNotices] = useState<readonly NotSent[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const sendingNow = useRef(false);
  const noticeKeys = useRef(0);
  // Read from callbacks that outlive the render which made them.
  const held = useRef(drafts);
  held.current = drafts;
  // Drafted items found open though the list does not hold them, for this filter.
  const foundOpen = useRef(new Set<string>());
  const asking = useRef(new Set<string>());

  const change = useCallback((id: string, next: Draft | undefined) => {
    storeDraft(id, next);
    setDrafts((all) =>
      next === undefined ? without(all, id) : { ...all, [id]: next },
    );
    setRefusals((all) => without(all, id));
    setSendError(undefined);
  }, []);

  /** Take a draft out of play, saying why, so its words stay readable. */
  const retire = useCallback((id: string, reason: string) => {
    const draft = held.current[id];
    if (draft === undefined) return;
    storeDraft(id, undefined);
    setDrafts((all) => without(all, id));
    setRefusals((all) => without(all, id));
    noticeKeys.current += 1;
    const key = noticeKeys.current;
    setNotices((all) => [...all, { ...draft, key, reason }]);
  }, []);

  /** A press on a choice: it becomes the draft's, or stops being if it was. */
  const pressChoice = useCallback(
    (view: HumanItemView, choice: HumanItemChoice) => {
      const { id, title } = view.item;
      const { text } = held.current[id] ?? {};
      const cleared = held.current[id]?.choice === choice.id;
      const next: Draft = {
        title,
        ...(cleared ? {} : { choice: choice.id, choiceTitle: choice.title }),
        ...(text === undefined ? {} : { text }),
      };
      change(id, isSendable(next) ? next : undefined);
    },
    [change],
  );

  const setText = useCallback(
    (view: HumanItemView, text: string) => {
      const { id, title } = view.item;
      const { choice, choiceTitle } = held.current[id] ?? {};
      const next: Draft = {
        title,
        ...(choice === undefined ? {} : { choice }),
        ...(choiceTitle === undefined ? {} : { choiceTitle }),
        ...(text === "" ? {} : { text }),
      };
      change(id, next.choice === undefined && text === "" ? undefined : next);
    },
    [change],
  );

  const sendable = Object.entries(drafts).filter(([, draft]) =>
    isSendable(draft),
  );
  const batch = sendable.slice(0, MAX_BATCH_ANSWERS);

  const settleRefused = useCallback(
    async (id: string, reason: string) => {
      const gone = await noLongerOpen(client, id);
      if (gone === true) retire(id, reason);
      else setRefusals((all) => ({ ...all, [id]: reason }));
    },
    [client, retire],
  );

  const send = useCallback(async () => {
    if (sendingNow.current) return;
    const stored = storedDrafts();
    const answers = batch.flatMap(([id, draft]) =>
      stored === undefined || stored[id] !== undefined
        ? [batchEntry(id, draft)]
        : [],
    );
    if (answers.length === 0) return;
    sendingNow.current = true;
    setSending(true);
    setSendError(undefined);
    try {
      const receipt = await client.answerHumanItems(answers);
      for (const { item } of receipt.answered) {
        storeDraft(item.item.id, undefined);
        setDrafts((all) => without(all, item.item.id));
        setRefusals((all) => without(all, item.item.id));
      }
      onAnswered(receipt.answered);
      await Promise.all(
        receipt.refused.map(({ id, refusal }) =>
          settleRefused(id, refusalReason(refusal)),
        ),
      );
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }, [batch, client, onAnswered, settleRefused]);

  const discard = useCallback(() => {
    for (const id of Object.keys(held.current)) storeDraft(id, undefined);
    setDrafts({});
    setRefusals({});
    setSendError(undefined);
  }, []);

  const clearNotice = useCallback((key: number) => {
    setNotices((all) => all.filter((notice) => notice.key !== key));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `filterKey` is the trigger — a hidden item found open under one filter says nothing under the next.
  useEffect(() => {
    foundOpen.current.clear();
  }, [filterKey]);

  // The list moved or a draft was added: any drafted item it no longer holds open
  // is retired. While a send is out its receipt is the one that decides.
  useEffect(() => {
    if (listed === undefined || sending) return;
    for (const id of Object.keys(drafts)) {
      if (writing(id)) continue;
      const view = listed.find(({ item }) => item.id === id);
      if (view !== undefined) {
        foundOpen.current.delete(id);
        if (view.item.state !== "open") retire(id, ELSEWHERE);
        continue;
      }
      if (foundOpen.current.has(id) || asking.current.has(id)) continue;
      asking.current.add(id);
      void noLongerOpen(client, id).then((gone) => {
        asking.current.delete(id);
        if (sendingNow.current) return;
        if (gone === true) retire(id, ELSEWHERE);
        else if (gone === false) foundOpen.current.add(id);
      });
    }
  }, [client, drafts, listed, retire, sending, writing]);

  return {
    drafts,
    refusals,
    notices,
    sending,
    sendError,
    /** How many drafts one press sends, at most the engine's batch limit. */
    count: batch.length,
    /** Sendable drafts a further press would send after this one. */
    remaining: sendable.length - batch.length,
    pressChoice,
    setText,
    retire,
    send,
    discard,
    clearNotice,
  };
}
