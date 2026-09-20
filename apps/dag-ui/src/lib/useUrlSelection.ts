import { API_V2_FILTER_PROFILES, isProjectId } from "@onepipeline-ui/dag-model";
import { useCallback, useSyncExternalStore } from "react";

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
  /**
   * How much of what the run recorded this reading carries.
   *
   * `activity` is the detailed stream — every record all three producing libraries
   * put on it — and `decisions` narrows to onepipeline's own vocabulary, which is
   * exactly the decisions: a node became ready, was dispatched, settled; an edit
   * was committed; a decision began holding dependents back and was cleared. It is
   * the same distinction the planner and an observer get on the CLI, and it is in
   * the query string for the same reason every other selection is — a reader who
   * narrowed their attention can send someone the reading they were looking at.
   *
   * Defaults to `activity`: a reader who asked for nothing is shown everything.
   */
  readonly detail: DetailLevel;
  readonly nodeTab: NodeTab;
  readonly selectList: (list: ListMode) => void;
  readonly selectProject: (projectKey?: string) => void;
  readonly selectRun: (runId: string) => void;
  readonly selectNode: (nodeId?: string) => void;
  readonly selectItem: (itemId?: string) => void;
  readonly showOverall: () => void;
  readonly selectDetail: (detail: DetailLevel) => void;
  readonly selectNodeTab: (tab: NodeTab) => void;
  /** Open one of the run's supervising readings: the channel, the watch, or the reads. */
  readonly selectView: (view: RunView) => void;
}

/**
 * The readings of one run. `graph` and `overall` are the two readings of its
 * recorded execution; `channel`, `watch` and `reads` are the supervising
 * surface — what the CLI does to a run once its plan has started, each wired to
 * the route the contract names for it.
 */
export const RUN_VIEWS = {
  graph: "graph",
  overall: "overall",
  channel: "channel",
  watch: "watch",
  reads: "reads",
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

/**
 * The two readings a viewer switches between, and the filter profile each one
 * asks the server for.
 *
 * Named profiles rather than inline specs: the server defines both for every run,
 * so the browser and the CLI narrow to the same thing under the same word, and a
 * spec written here would be a second definition of it.
 */
export const DETAIL_LEVELS = {
  decisions: {
    label: "Decisions",
    description: "Decision points and settlements only",
    profile: API_V2_FILTER_PROFILES.planner,
  },
  activity: {
    label: "Detailed activity",
    description: "Every record all three producers put on the stream",
    profile: API_V2_FILTER_PROFILES.detailed,
  },
} as const;
export type DetailLevel = keyof typeof DETAIL_LEVELS;

export function isDetailLevel(value: string | null): value is DetailLevel {
  return value !== null && Object.hasOwn(DETAIL_LEVELS, value);
}

export const NODE_TAB_LABELS = {
  timeline: "Timeline",
  task: "Task",
  criteria: "Acceptance criteria",
  dependencies: "Dependencies",
  pr: "PR",
  checks: "Checks",
};
export type NodeTab = keyof typeof NODE_TAB_LABELS;

export function isNodeTab(value: string | null): value is NodeTab {
  return value !== null && Object.hasOwn(NODE_TAB_LABELS, value);
}

/**
 * Whether an address value can be the opaque identifier the read API takes: a
 * run, a node or a timeline item is a non-empty token with no control character
 * and none of `/?#`, which is exactly what the telemetry client refuses to put
 * in a path. Checked here so a shared address that could never be served lands
 * where an unnamed one does rather than raising the client's refusal.
 */
function isOpaqueId(value: string): boolean {
  const hasControlCharacter = [...value].some(
    (character) => character.charCodeAt(0) < 32,
  );
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !hasControlCharacter &&
    !/[/?#]/u.test(value)
  );
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
  const namedDetail = params.get("detail");
  const detail: DetailLevel = isDetailLevel(namedDetail)
    ? namedDetail
    : "activity";
  const nodeTab = isNodeTab(namedTab) ? namedTab : "timeline";
  const view: RunView = isRunView(named)
    ? named
    : nodeId === undefined
      ? "overall"
      : "graph";

  const update = useCallback((change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(window.location.search);
    change(next);
    window.history.pushState(null, "", `${window.location.pathname}?${next}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return {
    list,
    projectKey,
    runId,
    nodeId,
    itemId,
    view,
    detail,
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
    // Only the reading changes: which run, which node and which moment are all
    // still what the reader was looking at, so narrowing the stream keeps their
    // place rather than sending them back to the top of the run.
    selectDetail: (level) =>
      update((next) => {
        if (level === "activity") next.delete("detail");
        else next.set("detail", level);
      }),
    selectNodeTab: (tab) =>
      update((next) => {
        if (tab === "timeline") next.delete("tab");
        else next.set("tab", tab);
        if (tab !== "timeline") next.delete("event");
      }),
    // A supervising reading is of the run as a whole, so whatever node and
    // moment were open close with the reading they belonged to.
    selectView: (view) =>
      update((next) => {
        next.set("view", view);
        next.delete("node");
        next.delete("event");
        next.delete("tab");
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
