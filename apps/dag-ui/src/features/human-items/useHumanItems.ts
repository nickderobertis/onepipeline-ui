import type {
  HumanItemDetail,
  HumanItemFilter,
  HumanItemReceipt,
  HumanItemView,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useRef, useState } from "react";

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

const PAST: { readonly [A in HumanItemWrite["action"]]: string } = {
  answer: "Answered",
  complete: "Completed",
  dismiss: "Dismissed",
};

/**
 * The action-item list under `filter`, the selected item's detail, and the
 * writes a reader makes — all read through the client, against the server's
 * own records.
 *
 * A write is refused here while one is pending for the same item, so a second
 * Enter or click cannot send a second request; the list is read again only once
 * the receipt (or the refusal) is in, so a pending item stays where it was.
 * Drafts are held apart from the reads, so a refusal or a re-read never takes a
 * reader's words away.
 */
export function useHumanItems(
  client: TelemetryClient,
  filter: HumanItemFilter,
  selectedId: string | undefined,
  refresh: number,
) {
  const [items, setItems] = useState<readonly HumanItemView[]>();
  const [listError, setListError] = useState<string>();
  const [detail, setDetail] = useState<HumanItemDetail>();
  const [detailError, setDetailError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [writes, setWrites] = useState<Readonly<Record<string, WriteState>>>(
    {},
  );
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [outcome, setOutcome] = useState<Outcome>();
  const inFlight = useRef(new Set<string>());
  const filterKey = JSON.stringify(filter);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `filterKey` is the filter's value, so a filter rebuilt each render with the same selectors is not a new read; `generation` is the re-read a settled write asks for, and `refresh` the one the header's Refresh asks for.
  useEffect(() => {
    let current = true;
    client.listHumanItems(filter).then(
      (list) => {
        if (!current) return;
        setItems(list.items);
        setListError(undefined);
      },
      (error: unknown) => {
        if (current) setListError(message(error));
      },
    );
    return () => {
      current = false;
    };
  }, [client, filterKey, generation, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` re-reads the open detail once a write settles, and `refresh` on the header's Refresh.
  useEffect(() => {
    if (selectedId === undefined) {
      setDetail(undefined);
      setDetailError(undefined);
      return;
    }
    let current = true;
    client.getHumanItem(selectedId).then(
      (read) => {
        if (!current) return;
        setDetail(read);
        setDetailError(undefined);
      },
      (error: unknown) => {
        if (!current) return;
        // A reread that fails drops what an earlier read served: the item may
        // now be another session's, so its content is no longer this one's.
        setDetail(undefined);
        setDetailError(message(error));
      },
    );
    return () => {
      current = false;
    };
  }, [client, selectedId, generation, refresh]);

  const write = useCallback(
    (view: HumanItemView, change: HumanItemWrite) => {
      const { id, title } = view.item;
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setWrites((all) => ({ ...all, [id]: { pending: true } }));
      const sent: Promise<HumanItemReceipt> =
        change.action === "answer"
          ? client.answerHumanItem(id, change.text)
          : change.action === "complete"
            ? client.completeHumanItem(id)
            : client.dismissHumanItem(id, change.reason);
      sent
        .then(
          () => {
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
          setGeneration((value) => value + 1);
        });
    },
    [client],
  );

  const setDraft = useCallback((id: string, text: string) => {
    setDrafts((all) => ({ ...all, [id]: text }));
  }, []);

  return {
    items,
    listError,
    detail: detail?.item.id === selectedId ? detail : undefined,
    detailError,
    writes,
    drafts,
    setDraft,
    write,
    outcome,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
