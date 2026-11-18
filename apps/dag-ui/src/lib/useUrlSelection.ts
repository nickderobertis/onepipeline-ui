import { isProjectId } from "@onepipeline-ui/dag-model";
import {
  type EventType,
  isEventType,
} from "@onepipeline-ui/timeline-categories";
import { useCallback, useSyncExternalStore } from "react";
import { isOpaqueId } from "../first-screen/address";
import { appRootPath } from "./humanItemsRoute";

/**
 * The whole drill-down, held in the query string: which run, which node, which view,
 * and which moment of that node's recorded execution. One mechanism, so every one of
 * them is bookmarkable and every one of them survives a back button.
 */
export interface UrlSelection {
  /**
   * Which list the navigation offers: the projects the runs belong to, or the
   * flat run list. The projects are what the app opens on — a manager reads a
   * host by project — and the flat list stays one toggle away for the reader
   * who wants every run in one order.
   */
  readonly list: ListMode;
  readonly host: boolean;
  readonly hiddenKinds: readonly string[];
  readonly selectHost: () => void;
  readonly selectKinds: (kinds: readonly string[]) => void;
  /**
   * The event types the reader hid from an event list, every one of them shown
   * where the address names none. Kept in the address as `hide-event`, once per
   * type, so a reload and a shared link read the list the way it was narrowed.
   */
  readonly hiddenEventTypes: readonly EventType[];
  readonly selectEventTypes: (hidden: readonly EventType[]) => void;
  /**
   * The project whose page is open, as the address spells it: a qualified
   * project id, or {@link NO_PROJECT_KEY} for the group of runs that recorded
   * none. Absent when no project page is open.
   */
  readonly projectKey?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  /**
   * The timeline item opened in the node view, by its recorded id.
   *
   * A span is as linkable as an event — a dispatch and one of its turns are both
   * moments of the node's execution — so this is an item id, not an event id. The
   * query key stays `event` because that is the shared address already in use.
   */
  readonly itemId?: string;
  /**
   * Which reading of the run is open.
   *
   * An address that names neither a view nor a node lands on `overall`: a run is
   * read as a whole first, and the graph is where a reader goes to open one node of
   * it. A link that does name a node is already asking for that node, so it opens
   * where the node view lives.
   */
  readonly view: RunView;
  readonly nodeTab: NodeTab;
  readonly selectList: (list: ListMode) => void;
  readonly selectProject: (projectKey?: string) => void;
  readonly selectRun: (runId: string) => void;
  readonly selectNode: (nodeId?: string) => void;
  readonly selectItem: (itemId?: string) => void;
  readonly showOverall: () => void;
  readonly selectNodeTab: (tab: NodeTab) => void;
}

/** The two readings of one run's recorded execution. */
export const RUN_VIEWS = {
  graph: "graph",
  overall: "overall",
} as const;
export type RunView = keyof typeof RUN_VIEWS;

export function isRunView(value: string | null): value is RunView {
  return value !== null && Object.hasOwn(RUN_VIEWS, value);
}

/**
 * The two lists the navigation offers. `projects` is the landing: nothing in the
 * address names one, so it is what an operator arriving at the observatory is
 * shown. `runs` is the flat list, and under it an address naming no run opens
 * the first one served, which is the list's whole point — the newest activity.
 */
export const LIST_MODES = {
  projects: "projects",
  runs: "runs",
} as const;
export type ListMode = keyof typeof LIST_MODES;

export function isListMode(value: string | null): value is ListMode {
  return value !== null && Object.hasOwn(LIST_MODES, value);
}

/**
 * How the address spells the `(no project)` group. The group has no id on the
 * wire — the contract makes it unaddressable by route, because it has none —
 * but a page of it is still a page somebody links to, so the address needs a
 * word for it. A project id is `<source>:<native>`, so a bare word can never
 * collide with one.
 */
export const NO_PROJECT_KEY = "none";

export const NODE_TAB_LABELS = {
  timeline: "Timeline",
  task: "Task",
  criteria: "Acceptance criteria",
  dependencies: "Dependencies",
  remote: "Remote",
};
export type NodeTab = keyof typeof NODE_TAB_LABELS;

export function isNodeTab(value: string | null): value is NodeTab {
  return value !== null && Object.hasOwn(NODE_TAB_LABELS, value);
}

/** The value of one address parameter, where it is an identifier at all. */
function identifier(params: URLSearchParams, key: string): string | undefined {
  const named = params.get(key);
  return named !== null && isOpaqueId(named) ? named : undefined;
}

export function useUrlSelection(): UrlSelection {
  const query = useSyncExternalStore(subscribe, currentQuery, currentQuery);
  const params = new URLSearchParams(query);
  const namedList = params.get("list");
  const list: ListMode = isListMode(namedList) ? namedList : "projects";
  // A project key is the reserved word or a qualified id under the contract's
  // grammar; anything else in a shared address is not a page and lands on the
  // projects, as an unnamed view lands on the run as a whole.
  const namedProject = params.get("project");
  const projectKey =
    namedProject !== null &&
    (namedProject === NO_PROJECT_KEY || isProjectId(namedProject))
      ? namedProject
      : undefined;
  const runId = identifier(params, "run");
  const nodeId = identifier(params, "node");
  const itemId = identifier(params, "event");
  const named = params.get("view");
  const namedTab = params.get("tab");
  const nodeTab =
    namedTab === "pr" || namedTab === "checks"
      ? "remote"
      : isNodeTab(namedTab)
        ? namedTab
        : "timeline";
  const view: RunView = isRunView(named)
    ? named
    : nodeId === undefined
      ? "overall"
      : "graph";

  // Every selection is of a run view or the Host page, so making one from the
  // action-items page leaves it for the app's root; the kinds shown are a
  // preference of the sidebar, which that page has too, so they stay put.
  const update = useCallback(
    (change: (next: URLSearchParams) => void, stay = false) => {
      const next = new URLSearchParams(window.location.search);
      change(next);
      const path = stay
        ? window.location.pathname
        : appRootPath(window.location.pathname);
      window.history.pushState(null, "", `${path}?${next}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [],
  );

  return {
    list,
    host: params.get("page") === "host",
    hiddenKinds: params.getAll("hide-kind"),
    hiddenEventTypes: [...new Set(params.getAll("hide-event"))].filter(
      isEventType,
    ),
    selectEventTypes: (hidden) =>
      update((next) => {
        next.delete("hide-event");
        for (const type of hidden) next.append("hide-event", type);
      }, true),
    selectHost: () =>
      update((next) => {
        next.set("page", "host");
      }),
    selectKinds: (kinds) =>
      update((next) => {
        next.delete("hide-kind");
        for (const kind of kinds) next.append("hide-kind", kind);
      }, true),
    projectKey,
    runId,
    nodeId,
    itemId,
    view,
    nodeTab,
    // Switching lists is a change of navigation, not of what is being read: the
    // run on screen stays on screen. The project page does not survive it, because
    // it belongs to the list being left.
    selectList: (mode) =>
      update((next) => {
        if (mode === "projects") next.delete("list");
        else next.set("list", mode);
        next.delete("project");
      }),
    // Opening a project is opening its page: whatever run was open closes with
    // everything under it, so the page is what the address lands on.
    selectProject: (key) =>
      update((next) => {
        if (key === undefined) next.delete("project");
        else next.set("project", key);
        next.delete("list");
        next.delete("run");
        next.delete("node");
        next.delete("event");
        next.delete("tab");
      }),
    // The reading stays where it was: an operator comparing two runs on the overall
    // view is not asking to be moved to the graph by picking the second one. The
    // project stays too, so a run opened from a project page is still linkable as
    // that project's run and the page is one step back.
    selectRun: (id) =>
      update((next) => {
        next.set("run", id);
        next.delete("page");
        next.delete("node");
        next.delete("event");
        next.delete("tab");
      }),
    // A different node has different recorded work, so the moment selected inside the
    // one being left cannot survive the move. Both a node and the way back out of one
    // live in the graph view, so this names it rather than falling back to the
    // landing view.
    selectNode: (id) =>
      update((next) => {
        if (id) next.set("node", id);
        else next.delete("node");
        next.delete("event");
        next.delete("tab");
        next.set("view", "graph");
      }),
    selectItem: (id) =>
      update((next) => {
        if (id) next.set("event", id);
        else next.delete("event");
      }),
    showOverall: () =>
      update((next) => {
        next.set("view", "overall");
        next.delete("node");
        next.delete("event");
        next.delete("tab");
      }),
    selectNodeTab: (tab) =>
      update((next) => {
        if (tab === "timeline") next.delete("tab");
        else next.set("tab", tab);
        if (tab !== "timeline") next.delete("event");
      }),
  };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function currentQuery(): string {
  return window.location.search;
}
