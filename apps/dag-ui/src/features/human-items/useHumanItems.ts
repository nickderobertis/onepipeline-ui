import type {
  HumanItem,
  HumanItemReceipt,
  HumanItemReopen,
  HumanItemView,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanItemsView,
  LiveHumanItems,
} from "../../lib/live-human-items";
import { type FilterChoice, NO_FILTER, toFilter } from "./human-items-model";
import { useAnswerDrafts } from "./useAnswerDrafts";

/** A write a reader can make on an item, as the route names it. */
export type HumanItemWrite =
  | { readonly action: "complete" }
  | { readonly action: "dismiss"; readonly reason?: string };

/** Where one item's last write stands. */
export interface WriteState {
  /** The engine's refusal of the last write, in its own words. */
  readonly error?: string;
}

/** What a toast offers after its write: taking it back, or saying why. */
export interface FollowUp {
  readonly kind: "undo" | "note";
  readonly phase: "sending" | "done" | "failed";
  /** Why it failed, in the engine's words or the transport's. */
  readonly error?: string;
}

/**
 * The one toast the page shows: the last write a reader made, and what can be
 * done about it. It appears as the write is sent, before the receipt.
 */
export interface Toast {
  /** A new write is a new toast, even of the same item. */
  readonly key: number;
  readonly id: string;
  readonly title: string;
  readonly action: HumanItemWrite["action"];
  /** Where the write itself stands. */
  readonly phase: "sending" | "done" | "failed";
  /** Why the write failed. */
  readonly error?: string;
  /** Whether the item can be reopened, as its receipt says once it lands. */
  readonly reopen?: HumanItemReopen;
  readonly followUp?: FollowUp | undefined;
}

/** A receipt the page is ahead of the stream with, and where its item stood. */
interface Settled {
  readonly view: HumanItemView;
  readonly at: number;
  /** The filter the list showed when the write was sent. */
  readonly filter: string;
}

/** A write out, and where its item stood in the list when it was sent. */
interface Hidden {
  readonly view: HumanItemView;
  readonly at: number;
}

/** What the page holds apart from what the server pushes: its own selection. */
export function useHumanItemsSelection(active: boolean) {
  const [choice, setChoice] = useState<FilterChoice>(NO_FILTER);
  const [selectedId, setSelectedId] = useState<string>();
  const filterKey = JSON.stringify(toFilter(choice));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `filterKey` is the filter's value, so a choice rebuilt with the same selectors is not a new subscription.
  const view = useMemo((): HumanItemsView | undefined => {
    if (!active) return undefined;
    const filter = toFilter(choice);
    return {
      type: "human-items",
      ...(Object.keys(filter).length === 0 ? {} : { filter }),
      ...(selectedId === undefined ? {} : { item: selectedId }),
    };
  }, [active, filterKey, selectedId]);
  // Leaving the page leaves its filters and selection behind with it.
  useEffect(() => {
    if (active) return;
    setChoice(NO_FILTER);
    setSelectedId(undefined);
  }, [active]);
  return { choice, setChoice, selectedId, setSelectedId, view };
}

/**
 * The action-item list and the selected item's detail, as the tab's subscription
 * holds them, and the writes a reader makes through the client.
 *
 * Nothing here reads: every change, this page's own among them, arrives on the
 * stream. Complete and Dismiss act at once: the card leaves as the write is sent
 * and a toast says so; a failure puts the card back where it was, with the
 * reason. Answers are drafted and go out together ({@link useAnswerDrafts}),
 * each question staying until its receipt. A second
 * write to an item already being written is refused here, so a repeated press
 * sends nothing. What a toast offers afterwards — taking the write back, or a
 * reason or comment — is sent only once the write's own receipt is in, in the
 * order it was asked for.
 */
export function useHumanItems(
  client: TelemetryClient,
  live: LiveHumanItems,
  selectedId: string | undefined,
  /** The one state the list's filter selects. */
  listedState: HumanItem["state"],
  /** The filter's value, so a change of it forgets what this page was ahead with. */
  filterKey = "",
) {
  const [writes, setWrites] = useState<Readonly<Record<string, WriteState>>>(
    {},
  );
  const [toast, setToast] = useState<Toast>();
  // Completed or dismissed here, receipt or not: gone from the list until a
  // failure brings it back.
  const [hidden, setHidden] = useState<Readonly<Record<string, Hidden>>>({});
  // What each accepted write's receipt says its item now is, until what the page
  // is shown of the server has caught up with it.
  const [settled, setSettled] = useState<Readonly<Record<string, Settled>>>({});
  // The item a failure put back, to be brought into view above the toast.
  const [returned, setReturned] = useState<{ readonly id: string }>();
  const inFlight = useRef(new Set<string>());
  const resolutions = useRef(new Map<number, Promise<HumanItemReceipt>>());
  const keys = useRef(0);
  const shownToast = useRef<Toast | undefined>(undefined);
  shownToast.current = toast;
  const pushed = live.items;
  // The filter in effect now, which a receipt landing later is held against.
  const currentFilter = useRef(filterKey);
  currentFilter.current = filterKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `filterKey` is the trigger — a new filter is a new list, which nothing this page was ahead of belongs to.
  useEffect(() => {
    setSettled((all) => (Object.keys(all).length === 0 ? all : {}));
  }, [filterKey]);
  const items = useMemo(() => {
    if (pushed === undefined) return undefined;
    const shown = pushed.flatMap((view) => {
      if (hidden[view.item.id] !== undefined) return [];
      const own = settled[view.item.id]?.view;
      if (own === undefined || !newer(own, view)) return [view];
      return own.item.state === listedState ? [own] : [];
    });
    const has = (id: string) => shown.some(({ item }) => item.id === id);
    // Taken back here before the stream says so: back where it was — in the list
    // it was taken back from, never one a later filter shows instead.
    for (const { view, at, filter } of Object.values(settled))
      if (
        filter === filterKey &&
        view.item.state === listedState &&
        !has(view.item.id)
      )
        shown.splice(Math.min(at, shown.length), 0, view);
    return shown;
  }, [pushed, settled, hidden, listedState, filterKey]);
  // A receipt is let go once what the page shows has caught up with it: the
  // item is served as new as the receipt, or is gone and was not to be shown.
  useEffect(() => {
    if (pushed === undefined) return;
    setSettled((all) => {
      const kept = Object.entries(all).filter(([id, { view: own }]) => {
        const view = pushed.find(({ item }) => item.id === id);
        return view === undefined
          ? own.item.state === listedState
          : newer(own, view);
      });
      return kept.length === Object.keys(all).length
        ? all
        : Object.fromEntries(kept);
    });
  }, [pushed, listedState]);
  // An error drops what an earlier reading served: the pane falls back to what
  // the list last showed, beside the refusal.
  const pushedDetail =
    live.error === undefined && live.item === selectedId
      ? live.detail
      : undefined;
  const ownDetail =
    selectedId === undefined ? undefined : settled[selectedId]?.view;
  const served =
    pushedDetail &&
    ownDetail !== undefined &&
    newer(ownDetail, { item: pushedDetail.item })
      ? { ...pushedDetail, item: ownDetail.item, reopen: ownDetail.reopen }
      : pushedDetail;
  const listed = useRef(pushed);
  listed.current = pushed;

  const writing = useCallback((id: string) => inFlight.current.has(id), []);
  const onAnswered = useCallback((receipts: readonly HumanItemReceipt[]) => {
    const filter = currentFilter.current;
    setSettled((all) => {
      const next = { ...all };
      for (const { item: view } of receipts) {
        const at = Math.max(
          0,
          listed.current?.findIndex(({ item }) => item.id === view.item.id) ??
            0,
        );
        next[view.item.id] = { view, at, filter };
      }
      return next;
    });
  }, []);
  const answers = useAnswerDrafts(
    client,
    pushed,
    filterKey,
    writing,
    onAnswered,
  );
  const { retire } = answers;

  const onToast = useCallback(
    (key: number, change: (held: Toast) => Toast) =>
      setToast((held) => (held?.key === key ? change(held) : held)),
    [],
  );

  const write = useCallback(
    (view: HumanItemView, change: HumanItemWrite) => {
      const { id, title } = view.item;
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      const key = ++keys.current;
      const filter = currentFilter.current;
      const at = Math.max(
        0,
        listed.current?.findIndex(({ item }) => item.id === id) ?? 0,
      );
      setWrites((all) => ({ ...all, [id]: {} }));
      setHidden((all) => ({ ...all, [id]: { view, at } }));
      setToast({ key, id, title, action: change.action, phase: "sending" });
      const sent: Promise<HumanItemReceipt> =
        change.action === "complete"
          ? client.completeHumanItem(id)
          : client.dismissHumanItem(id, change.reason);
      resolutions.current.set(key, sent);
      sent
        .then(
          (receipt) => {
            setSettled((all) => ({
              ...all,
              [id]: { view: receipt.item, at, filter },
            }));
            setWrites((all) => ({ ...all, [id]: {} }));
            retire(id, "dismissed here");
            onToast(key, (held) => ({
              ...held,
              phase: "done",
              reopen: receipt.item.reopen,
            }));
          },
          (error: unknown) => {
            const refusal = message(error);
            setWrites((all) => ({
              ...all,
              [id]: { error: refusal },
            }));
            onToast(key, (held) => ({
              ...held,
              phase: "failed",
              error: refusal,
            }));
            setReturned({ id });
          },
        )
        .finally(() => {
          inFlight.current.delete(id);
          setHidden(forget(id));
        });
    },
    [client, onToast, retire],
  );

  /**
   * Send `follow` once the toast's own write is in, and only if it succeeded: a
   * reopen or a note pressed before the receipt waits for it, in order.
   */
  const followUp = useCallback(
    (
      kind: FollowUp["kind"],
      send: (id: string) => Promise<HumanItemReceipt>,
    ) => {
      const held = shownToast.current;
      if (held === undefined) return;
      const resolving = resolutions.current.get(held.key);
      if (resolving === undefined || held.followUp?.phase === "sending") return;
      const { key, id } = held;
      const filter = currentFilter.current;
      onToast(key, (current) => ({
        ...current,
        followUp: { kind, phase: "sending" },
      }));
      resolving.then(
        (receipt) => {
          if (kind === "undo" && !receipt.item.reopen.available) {
            // Pressed before the receipt said it could not be: nothing is sent.
            onToast(key, (current) => ({ ...current, followUp: undefined }));
            return;
          }
          send(id).then(
            (after) => {
              setSettled((all) => ({
                ...all,
                [id]: { view: after.item, at: all[id]?.at ?? 0, filter },
              }));
              onToast(key, (current) => ({
                ...current,
                reopen: after.item.reopen,
                followUp: { kind, phase: "done" },
              }));
            },
            (error: unknown) =>
              onToast(key, (current) => ({
                ...current,
                followUp: { kind, phase: "failed", error: message(error) },
              })),
          );
        },
        // The write itself failed: there is nothing to take back or annotate,
        // and its toast already says why.
        () => onToast(key, (current) => ({ ...current, followUp: undefined })),
      );
    },
    [onToast],
  );

  const undo = useCallback(
    () => followUp("undo", (id) => client.reopenHumanItem(id)),
    [client, followUp],
  );
  const note = useCallback(
    (text: string) => followUp("note", (id) => client.noteHumanItem(id, text)),
    [client, followUp],
  );
  const closeToast = useCallback(() => setToast(undefined), []);

  return {
    items,
    listError:
      selectedId === undefined || items === undefined ? live.error : undefined,
    detail: served === null ? undefined : served,
    // Asked for and no longer read: gone, which is resolved rather than an error.
    gone: selectedId !== undefined && served === null,
    detailError: selectedId === undefined ? undefined : live.error,
    writes,
    answers,
    write,
    toast,
    undo,
    note,
    closeToast,
    returned,
  };
}

/**
 * Returns `all` itself when it holds nothing for `id`, so a settle that has
 * nothing to forget leaves the state unchanged and React skips the re-render.
 */
function forget(id: string) {
  return (all: Readonly<Record<string, Hidden>>) => {
    if (all[id] === undefined) return all;
    return Object.fromEntries(
      Object.entries(all).filter(([held]) => held !== id),
    );
  };
}

/** Whether a receipt says more recent things of its item than `view` does. */
function newer(
  own: HumanItemView,
  view: { readonly item: HumanItemView["item"] },
): boolean {
  return Date.parse(own.item.updated_at) > Date.parse(view.item.updated_at);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
