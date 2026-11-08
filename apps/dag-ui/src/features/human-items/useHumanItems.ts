import type {
  HumanItem,
  HumanItemReceipt,
  HumanItemView,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanItemsView,
  LiveHumanItems,
} from "../../lib/live-human-items";
import { type FilterChoice, NO_FILTER, toFilter } from "./human-items-model";

/** A write a reader can make on an item, as the route names it. */
export type HumanItemWrite =
  | { readonly action: "answer"; readonly text: string }
  | { readonly action: "complete" }
  | { readonly action: "dismiss"; readonly reason?: string };

/** Where one item's last write stands. */
export interface WriteState {
  /** The receipt has not arrived: the item stays open on the page meanwhile. */
  readonly pending: boolean;
  /** The engine's refusal of the last write, in its own words. */
  readonly error?: string;
}

/** The outcome the page announces, which survives the card it was about. */
export interface Outcome {
  readonly title: string;
  readonly message: string;
  readonly failed: boolean;
}

/** A write out, and where its item stood in the list when it was sent. */
interface Sending {
  readonly view: HumanItemView;
  readonly at: number;
}

const PAST: { readonly [A in HumanItemWrite["action"]]: string } = {
  answer: "Answered",
  complete: "Completed",
  dismiss: "Dismissed",
};

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
 * stream. A write is refused here while one is pending for the same item, so a
 * second Enter or click cannot send a second request, and an item stays where it
 * was until its receipt (or refusal) is in, even if the stream got there first.
 * Drafts are held apart from what is pushed, so a refusal or a patch never takes
 * a reader's words away.
 */
export function useHumanItems(
  client: TelemetryClient,
  live: LiveHumanItems,
  selectedId: string | undefined,
  /** The one state the list's filter selects. */
  listedState: HumanItem["state"],
) {
  const [writes, setWrites] = useState<Readonly<Record<string, WriteState>>>(
    {},
  );
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [outcome, setOutcome] = useState<Outcome>();
  const [sending, setSending] = useState<readonly Sending[]>([]);
  // What each accepted write's receipt says its item now is, until what the page
  // is shown of the server has caught up with it.
  const [settled, setSettled] = useState<
    Readonly<Record<string, HumanItemView>>
  >({});
  const inFlight = useRef(new Set<string>());
  const pushed = live.items;
  const items = useMemo(() => {
    if (pushed === undefined) return undefined;
    const shown = pushed.flatMap((view) => {
      const own = settled[view.item.id];
      if (own === undefined || !newer(own, view)) return [view];
      return own.item.state === listedState ? [own] : [];
    });
    for (const { view, at } of sending)
      if (!shown.some(({ item }) => item.id === view.item.id))
        shown.splice(at, 0, view);
    return shown;
  }, [pushed, sending, settled, listedState]);
  // A receipt is let go once what the page shows has caught up with it.
  useEffect(() => {
    if (pushed === undefined) return;
    setSettled((all) => {
      const kept = Object.entries(all).filter(([id, own]) => {
        const view = pushed.find(({ item }) => item.id === id);
        return view !== undefined && newer(own, view);
      });
      return kept.length === Object.keys(all).length
        ? all
        : Object.fromEntries(kept);
    });
  }, [pushed]);
  // An error drops what an earlier reading served: the pane falls back to what
  // the list last showed, beside the refusal.
  const pushedDetail =
    live.error === undefined && live.item === selectedId
      ? live.detail
      : undefined;
  const ownDetail = selectedId === undefined ? undefined : settled[selectedId];
  const served =
    pushedDetail &&
    ownDetail !== undefined &&
    newer(ownDetail, { item: pushedDetail.item })
      ? { ...pushedDetail, item: ownDetail.item }
      : pushedDetail;
  const listed = useRef(pushed);
  listed.current = pushed;

  const write = useCallback(
    (view: HumanItemView, change: HumanItemWrite) => {
      const { id, title } = view.item;
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setWrites((all) => ({ ...all, [id]: { pending: true } }));
      const at = Math.max(
        0,
        listed.current?.findIndex(({ item }) => item.id === id) ?? 0,
      );
      setSending((all) => [...all, { view, at }]);
      const sent: Promise<HumanItemReceipt> =
        change.action === "answer"
          ? client.answerHumanItem(id, change.text)
          : change.action === "complete"
            ? client.completeHumanItem(id)
            : client.dismissHumanItem(id, change.reason);
      sent
        .then(
          (receipt) => {
            setSettled((all) => ({ ...all, [id]: receipt.item }));
            setWrites((all) => ({ ...all, [id]: { pending: false } }));
            setDrafts((all) =>
              Object.fromEntries(
                Object.entries(all).filter(([held]) => held !== id),
              ),
            );
            setOutcome({ title, message: PAST[change.action], failed: false });
          },
          (error: unknown) => {
            const refusal = message(error);
            setWrites((all) => ({
              ...all,
              [id]: { pending: false, error: refusal },
            }));
            setOutcome({ title, message: refusal, failed: true });
          },
        )
        .finally(() => {
          inFlight.current.delete(id);
          setSending((all) => all.filter(({ view }) => view.item.id !== id));
        });
    },
    [client],
  );

  const setDraft = useCallback((id: string, text: string) => {
    setDrafts((all) => ({ ...all, [id]: text }));
  }, []);

  return {
    items,
    listError:
      selectedId === undefined || items === undefined ? live.error : undefined,
    detail: served === null ? undefined : served,
    // Asked for and no longer read: gone, which is resolved rather than an error.
    gone: selectedId !== undefined && served === null,
    detailError: selectedId === undefined ? undefined : live.error,
    writes,
    drafts,
    setDraft,
    write,
    outcome,
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
