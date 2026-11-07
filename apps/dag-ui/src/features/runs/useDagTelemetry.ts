import type {
  ChannelQueue,
  LiveActivity,
  RunDetail,
  RunTimeline,
  SidebarRow,
  SubscriptionView,
} from "@onepipeline-ui/dag-model";
import { liveActivityListSchema } from "@onepipeline-ui/dag-model";
import {
  type LiveState,
  type LiveView,
  type TelemetryClient,
  TelemetryClientError,
} from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanItemsView,
  LiveHumanItems,
} from "../../lib/live-human-items";
import { changedRowCount, newestRows } from "../../lib/sidebar-model";
import type { UpdateSetting } from "../updates/update-settings";
import { useHeldArea } from "../updates/useHeldArea";

// llmlint: ignore-file[changed_behavior_has_e2e] The browser journeys in
// apps/dag-ui-e2e/dag-ui-live-updates.spec.ts drive every branch a conforming
// server reaches against the real one: the opening snapshot, a run.changed row
// for another run, a detail, timeline and channel patch for the open run, a
// switch of view replacing the subscription, and a stream dropped and resumed;
// apps/dag-ui-e2e/dag-ui-human-items.spec.ts drives Action items on the same one.
// What only a broken peer reaches — a frame that fails validation, a patch that
// does not apply — is proven in App.test.tsx at the browser boundary.

/**
 * How long after a person's write each area shows changes as they arrive: long
 * enough for the server's slowest push of what the write moved, a run's row,
 * which it sends at most once every 10 polls of 500 ms.
 */
const OWN_WRITE_FOLLOWED_MS = 10_000;

/** Which of a run's views the page shows. */
export type RunViewKind = "graph" | "overall" | "node" | "channel";

export interface DagTelemetryOptions {
  /** The run the address names. */
  readonly runId?: string;
  readonly view: RunViewKind;
  /** The node a node timeline is of. */
  readonly nodeId?: string;
  /** The filter profile every payload is read under. */
  readonly filter?: string;
  /**
   * Whether an address naming no run opens the first one served: not on the
   * Host page, which is about the host rather than any run.
   */
  readonly selectFirst: boolean;
  /** The Host page subscribes to the sidebar alone. */
  readonly host: boolean;
  /**
   * The view Action items shows, which takes the place of the sidebar-only
   * subscription and still carries the sidebar.
   */
  readonly humanItems?: HumanItemsView;
  /** How the navigation takes the rows the stream delivers. */
  readonly navigationUpdates: UpdateSetting;
  /** How the main area takes the view's changes the stream delivers. */
  readonly mainUpdates: UpdateSetting;
}

/** What the main area shows of one state: the view it was served for. */
interface MainCopy {
  readonly state: LiveState;
  readonly view: SubscriptionView;
  /** The whole re-send that produced it, if one did. */
  readonly reset?: string;
}

export interface DagTelemetryState {
  /** The sidebar's trimmed rows, as of the last frame applied. */
  readonly rows?: readonly SidebarRow[];
  /** The navigation's copy of those rows, taken as its setting says. */
  readonly navigationRows?: readonly SidebarRow[];
  /** The changes the navigation is holding. */
  readonly navigationWaiting: number;
  /** The Host page's copy of those rows, taken as the main area's setting says. */
  readonly hostRows?: readonly SidebarRow[];
  /** The changes the main area is holding. */
  readonly mainWaiting: number;
  /** The run being shown: the requested one when it is served, else the newest. */
  readonly runId?: string;
  readonly detail?: RunDetail;
  readonly timeline?: RunTimeline;
  readonly channel?: ChannelQueue;
  readonly humanItems: LiveHumanItems;
  /**
   * A timeline view the server would not subscribe, reported where the timeline
   * would have been, beside the detail already on screen.
   */
  readonly timelineError?: Error;
  readonly loading: boolean;
  readonly lastUpdated?: string;
  readonly activity: readonly LiveActivity[];
  readonly error?: Error;
  /** An explicit re-send the server made, named, so the reader knows it happened. */
  readonly notice?: string;
  /** Show what is held and subscribe again, from scratch. */
  readonly refresh: () => void;
}

/**
 * The page's one subscription: the sidebar and the one visible run view, kept
 * current by what the server pushes (`docs/contract.md`, "Subscriptions").
 *
 * Nothing here polls or re-reads. A tab subscribes to what it shows; moving to
 * another view replaces the subscription, so a view left behind is neither read
 * nor pushed; and every change arrives as a trimmed row or a patch of the
 * payload already on screen.
 *
 * What the stream delivers is applied to the held state as it arrives, and each
 * area shows its own copy as its setting says: row frames feed the navigation,
 * and the view's patches the main area, which on the Host page is fed the rows
 * as well, since it shows them. A person's own act shows at once: a change of
 * view answers its snapshot, Refresh shows everything, and a write is followed.
 * With both areas off the stream is closed, and the applied cursor is what it
 * resumes from.
 */
export function useDagTelemetry(
  client: TelemetryClient,
  options: DagTelemetryOptions,
): DagTelemetryState {
  const [state, setState] = useState<LiveState>();
  const [humanItems, setHumanItems] = useState<LiveHumanItems>({});
  const latestRows = useRef<readonly SidebarRow[]>([]);
  const [rows, setRows] = useState<readonly SidebarRow[]>();
  const [navigationRows, setNavigationRows] = useState<readonly SidebarRow[]>();
  const [followingWrite, setFollowingWrite] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [error, setError] = useState<Error>();
  //: The stream dropped and has not delivered since — cleared by what it sends next.
  const [streamError, setStreamError] = useState<Error>();
  const [notice, setNotice] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const requested = options.runId;
  const runId =
    rows === undefined
      ? requested
      : requested !== undefined && rows.some((row) => row.id === requested)
        ? requested
        : requested !== undefined || options.selectFirst
          ? newestRows(rows)[0]?.id
          : undefined;
  const view = useMemo(
    () =>
      options.humanItems ??
      subscriptionView(
        options.host ? undefined : runId,
        options.view,
        options.nodeId,
        options.filter,
      ),
    [
      options.humanItems,
      options.host,
      runId,
      options.view,
      options.nodeId,
      options.filter,
    ],
  );
  const live = useRef<LiveView | undefined>(undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  const navigation = useHeldArea(
    options.navigationUpdates,
    followingWrite,
    setNavigationRows,
  );
  const main = useHeldArea<MainCopy>(
    options.mainUpdates,
    followingWrite,
    useCallback((copy) => {
      setState(copy.state);
      const { visible } = copy.state;
      if (visible.type === "human-items") {
        const { items, detail } = visible;
        setHumanItems({
          items,
          detail,
          ...(copy.view.type === "human-items" && copy.view.item !== undefined
            ? { item: copy.view.item }
            : {}),
        });
      }
      setLastUpdated(new Date().toISOString());
      if (copy.reset !== undefined)
        setNotice(`The live view was re-sent whole: ${copy.reset}.`);
    }, []),
  );
  const streamWanted =
    options.navigationUpdates !== "off" ||
    options.mainUpdates !== "off" ||
    followingWrite;
  const wantsStream = useRef(streamWanted);
  wantsStream.current = streamWanted;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is not read here — bumping it is how a refresh asks for a new subscription; the view in effect is read off the ref so a view change replaces the subscription below rather than tearing this one down.
  useEffect(() => {
    setError(undefined);
    let first = true;
    const subscription = client.live({
      view: viewRef.current,
      paused: !wantsStream.current,
      onState: (next, cause) => {
        // The rows as of the last frame applied, which is what says which runs
        // exist, whatever either area is showing.
        const before = latestRows.current;
        latestRows.current = next.sidebar;
        setRows(next.sidebar);
        setError(undefined);
        setStreamError(undefined);
        const copy: MainCopy = {
          state: next,
          view: subscription.view,
          ...(cause.kind === "reset" ? { reset: cause.reason } : {}),
        };
        if (cause.kind === "snapshot") {
          // A person moved to this view, or the page or Refresh is taking
          // everything: it shows. The rows are the navigation's only when this
          // subscription has shown it none yet.
          main.show(copy);
          if (first) navigation.show(next.sidebar);
          else if (before !== next.sidebar) {
            const moved = changedRowCount(before, next.sidebar);
            if (moved > 0) navigation.offer(next.sidebar, moved);
          }
          first = false;
          return;
        }
        if (cause.kind === "reset") {
          navigation.offer(next.sidebar);
          main.offer(copy);
          return;
        }
        const rowFrame =
          cause.frame.type === "run.changed" ||
          cause.frame.type === "run.removed";
        if (rowFrame) navigation.offer(next.sidebar);
        if (!rowFrame || next.visible.type === "sidebar") main.offer(copy);
      },
      onError: (caught) => {
        // Action items that cannot be served are the page's to say, in the
        // engine's words and beside what it last showed, and the tab still
        // carries the sidebar, as a host with none enabled must.
        if (subscription.view.type === "human-items") {
          setHumanItems((held) => ({
            ...(held.items === undefined ? {} : { items: held.items }),
            error: caught.message,
          }));
          subscription.change({ type: "sidebar" });
          return;
        }
        // A run the address names that is not served is not an error: the
        // sidebar is subscribed to instead, and the newest run is opened.
        if (
          caught instanceof TelemetryClientError &&
          (caught.code === "run_not_found" || caught.code === "node_not_found")
        ) {
          subscription.change({ type: "sidebar" });
          return;
        }
        setError(caught);
      },
      onDisconnected: () =>
        setStreamError(new Error("Live telemetry stream disconnected")),
      onConnected: () => setStreamError(undefined),
    });
    live.current = subscription;
    return () => {
      subscription.close();
      if (live.current === subscription) live.current = undefined;
    };
  }, [
    client,
    generation,
    main.show,
    main.offer,
    navigation.show,
    navigation.offer,
  ]);

  useEffect(() => {
    if (JSON.stringify(live.current?.view) !== JSON.stringify(view))
      main.drop();
    live.current?.change(view);
    if (view.type !== "human-items")
      setHumanItems((held) => (Object.keys(held).length === 0 ? held : {}));
  }, [view, main.drop]);

  useEffect(() => {
    if (streamWanted) live.current?.resume();
    else live.current?.pause();
  }, [streamWanted]);

  // A person's accepted write shows at once in either area: what is held now,
  // and, for a while, what the write moves as the server pushes it. With both
  // areas off the stream opens for that while, from the applied cursor.
  const takeAll = useCallback(() => {
    navigation.take();
    main.take();
  }, [navigation.take, main.take]);
  useEffect(() => {
    let followed: ReturnType<typeof setTimeout> | undefined;
    const stop = client.onWrite(() => {
      takeAll();
      setFollowingWrite(true);
      clearTimeout(followed);
      followed = setTimeout(
        () => setFollowingWrite(false),
        OWN_WRITE_FOLLOWED_MS,
      );
    });
    return () => {
      stop();
      clearTimeout(followed);
    };
  }, [client, takeAll]);

  const refresh = useCallback(() => {
    setNotice(undefined);
    takeAll();
    setGeneration((current) => current + 1);
  }, [takeAll]);

  const visible = state?.visible;
  const shown =
    visible !== undefined &&
    visible.type !== "sidebar" &&
    visible.type !== "human-items" &&
    visible.run_id === runId &&
    sameView(visible, view)
      ? visible
      : undefined;
  // The detail stays on screen across a change of view of the same run.
  const heldDetail = useRef<RunDetail | undefined>(undefined);
  const detail =
    shown?.detail ??
    (heldDetail.current?.run.run_id === runId ? heldDetail.current : undefined);
  heldDetail.current = detail;
  const activity = useMemo(() => activityOf(detail), [detail]);
  const timelineRefused =
    error !== undefined && view.type === "timeline" && detail !== undefined;
  return {
    rows,
    navigationRows,
    navigationWaiting: navigation.waiting,
    hostRows: state?.sidebar,
    mainWaiting: main.waiting,
    runId,
    detail,
    timeline: shown && "timeline" in shown ? shown.timeline : undefined,
    channel: shown && "channel" in shown ? shown.channel : undefined,
    humanItems,
    timelineError: timelineRefused ? error : undefined,
    loading: state === undefined && error === undefined,
    lastUpdated,
    activity,
    error: timelineRefused ? streamError : (error ?? streamError),
    notice,
    refresh,
  };
}

/** The subscription a page state shows. */
function subscriptionView(
  runId: string | undefined,
  kind: RunViewKind,
  nodeId: string | undefined,
  filter: string | undefined,
): SubscriptionView {
  if (runId === undefined) return { type: "sidebar" };
  const filtered = filter === undefined ? {} : { filter };
  switch (kind) {
    case "channel":
      return { type: "channel", run_id: runId };
    case "overall":
      return { type: "timeline", run_id: runId, scope: "run", ...filtered };
    case "node":
      return nodeId === undefined
        ? { type: "detail", run_id: runId, ...filtered }
        : {
            type: "timeline",
            run_id: runId,
            scope: "node",
            node: nodeId,
            ...filtered,
          };
    case "graph":
      return { type: "detail", run_id: runId, ...filtered };
  }
}

/** Whether the visible state the server sent is the view the page asks for. */
function sameView(
  visible: Exclude<LiveState["visible"], { type: "sidebar" | "human-items" }>,
  view: SubscriptionView,
): boolean {
  if (view.type !== visible.type) return false;
  if (view.type === "timeline" && visible.type === "timeline")
    return (
      view.scope === visible.scope &&
      (view.scope === "run" ||
        (visible.scope === "node" && visible.node === view.node))
    );
  return true;
}

/** The header's live activity line, as the detail carries it. */
function activityOf(detail: RunDetail | undefined): readonly LiveActivity[] {
  const candidate = detail?.run.live_activity;
  if (candidate === undefined) return [];
  // The live view validates each patched detail as a whole; the activity line
  // is read through its own schema too, so an entry it cannot read is no line
  // rather than a crash.
  const parsed = liveActivityListSchema.safeParse(candidate);
  return parsed.success ? parsed.data : [];
}
