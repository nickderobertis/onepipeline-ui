import {
  type LiveRunDetail,
  parseRunDetail,
  parseRunList,
} from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";
import { LIVE_RUN, runDetail, runList } from "../test/fixtures";
import {
  awaitedLine,
  awaitedReleases,
  cardLines,
  doneCount,
  graphOf,
  isOwnWorkLost,
  isUnhealthy,
  launchLabel,
  nodeKindWord,
  nodeReason,
  nodeViews,
  openedNode,
  runState,
} from "./run-model";

const live = parseRunDetail(runDetail(LIVE_RUN));
const summaries = parseRunList(runList).runs;

function statusesWithout<Status>(
  statuses: Readonly<Record<string, Status>>,
  dropped: string,
): Record<string, Status> {
  return Object.fromEntries(
    Object.entries(statuses).filter(([node]) => node !== dropped),
  );
}

/**
 * The live run as served after a live edit took `dropped` off its graph: the plan
 * and the per-node statuses no longer name it, and everything else the server
 * recorded for it stays.
 */
function withoutOnGraph(dropped: string): LiveRunDetail {
  const graph = live.graph;
  if (graph === undefined || graph === null) throw new Error("fixture graph");
  const node_status = statusesWithout(graph.node_status, dropped);
  return {
    ...live,
    graph: {
      ...graph,
      plan: {
        ...graph.plan,
        tasks: graph.plan.tasks.filter((task) => task.id !== dropped),
      },
      node_status,
    },
  };
}

describe("the node an address names", () => {
  test("is the graph's own view of a node on the graph", () => {
    const nodes = nodeViews(live);
    expect(openedNode(live, nodes, "dashboard")).toBe(
      nodes.find(({ id }) => id === "dashboard"),
    );
    expect(openedNode(live, nodes, undefined)).toBeUndefined();
    expect(openedNode(undefined, nodes, "dashboard")).toBeUndefined();
  });

  test("is a view of what the run recorded for a node its graph no longer holds", () => {
    const detail = withoutOnGraph("publish");
    const opened = openedNode(detail, nodeViews(detail), "publish");
    expect(opened).toMatchObject({
      id: "publish",
      label: "publish",
      offGraph: true,
      status: "failed",
      failure: { class: "agent", detail: "Deploy failed" },
      result: { detail: "Deploy failed" },
      blockers: [],
      dependents: [],
    });
    expect(opened?.task).toBeUndefined();
    expect(opened?.telemetry?.node).toBe("publish");
    if (opened === undefined) throw new Error("no view");
    expect(nodeKindWord(opened)).toBe("off-graph");
  });

  test("reads a status the server recorded in no word it knows as unknown", () => {
    const detail = withoutOnGraph("publish");
    const odd = {
      ...detail,
      run: {
        ...detail.run,
        nodes: detail.run.nodes.map((node) =>
          node.node === "publish" ? { ...node, status: "a-later-word" } : node,
        ),
      },
    };
    expect(openedNode(odd, nodeViews(odd), "publish")?.status).toBe("unknown");
    expect(openedNode(odd, nodeViews(odd), "never-recorded")).toMatchObject({
      status: "unknown",
      offGraph: true,
      telemetry: undefined,
    });
  });

  test("is nothing while the graph is unknown, or for a planned node with no status", () => {
    expect(openedNode({ ...live, graph: null }, [], "publish")).toBeUndefined();
    const graph = live.graph;
    if (graph === undefined || graph === null) throw new Error("fixture graph");
    const statusless = {
      ...live,
      graph: {
        ...graph,
        node_status: statusesWithout(graph.node_status, "publish"),
      },
    };
    expect(
      openedNode(statusless, nodeViews(statusless), "publish"),
    ).toBeUndefined();
  });
});

describe("node views", () => {
  test("classifies kind, reads the served status, and carries each node's record", () => {
    const views = nodeViews(live);
    expect(views.map(({ id }) => id)).toEqual([
      "foundation",
      "dashboard",
      "publish",
      "approval",
      "queued",
      "abandoned",
      "followup",
      "obsolete",
    ]);
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get("foundation")?.kind).toBe("change");
    expect(byId.get("approval")?.kind).toBe("human");
    expect(byId.get("dashboard")?.kind).toBe("agent");
    expect(byId.get("dashboard")?.telemetry?.turns).toBe(2);
    expect(byId.get("publish")?.result?.detail).toBe("Deploy failed");

    // Every status is the one the server served, including the three the journal
    // never recorded and a client used to have to invent as "pending".
    expect(
      Object.fromEntries(views.map((view) => [view.id, view.status])),
    ).toEqual({
      foundation: "done",
      dashboard: "running",
      publish: "failed",
      approval: "waiting",
      queued: "blocked",
      abandoned: "skipped",
      followup: "pending",
      obsolete: "cancelled",
    });
  });

  test("carries the served blockers and failure of the nodes that have them", () => {
    const byId = new Map(nodeViews(live).map((view) => [view.id, view]));
    expect(byId.get("queued")?.blockers).toEqual(["approval"]);
    expect(byId.get("abandoned")?.blockers).toEqual(["publish"]);
    expect(byId.get("dashboard")?.blockers).toEqual([]);
    expect(byId.get("publish")?.failure).toEqual({
      class: "agent",
      detail: "Deploy failed",
    });
    expect(byId.get("dashboard")?.failure).toBeUndefined();
  });

  test("states one reason per node that is not making progress, and none otherwise", () => {
    const byId = new Map(nodeViews(live).map((view) => [view.id, view]));
    const reason = (id: string) => {
      const view = byId.get(id);
      if (view === undefined) throw new Error(`fixture has no ${id}`);
      return nodeReason(view);
    };
    expect(reason("queued")).toBe("blocked by approval");
    expect(reason("abandoned")).toBe("blocked by publish");
    expect(reason("publish")).toBe("Deploy failed");
    // Healthy work has nothing to report, and must not be given a line that reads
    // as though it does.
    expect(reason("dashboard")).toBeUndefined();
    expect(reason("foundation")).toBeUndefined();
    expect(reason("followup")).toBeUndefined();

    expect(
      ["queued", "abandoned", "publish", "obsolete"].map((id) =>
        isUnhealthy(byId.get(id)?.status ?? "unknown"),
      ),
    ).toEqual([true, true, true, true]);
    expect(
      ["foundation", "dashboard", "followup", "approval"].map((id) =>
        isUnhealthy(byId.get(id)?.status ?? "unknown"),
      ),
    ).toEqual([false, false, false, false]);
  });

  test("says a node failed with no recorded reason rather than showing nothing", () => {
    const payload = runDetail(LIVE_RUN);
    const bare = parseRunDetail({
      ...payload,
      run: {
        ...payload.run,
        nodes: payload.run.nodes.filter(({ node }) => node !== "publish"),
      },
      graph: {
        ...payload.graph,
        node_results: {
          ...payload.graph.node_results,
          publish: { status: "failed" },
        },
      },
    });
    const publish = nodeViews(bare).find(({ id }) => id === "publish");
    if (publish === undefined) throw new Error("fixture has no publish node");
    expect(nodeReason(publish)).toBe("failed, with no reason recorded");
  });

  test("reads finished work held for a release as neither lost, blocking nor unhealthy, and names what it awaits", () => {
    const payload = runDetail(LIVE_RUN);
    const engine = "github.com/example/engine";
    const schemas = "github.com/example/schemas";
    const held = parseRunDetail({
      ...payload,
      graph: {
        ...payload.graph,
        node_status: {
          ...payload.graph.node_status,
          followup: "complete-but-held",
          publish: "complete-but-draft",
        },
        node_results: {
          ...payload.graph.node_results,
          followup: {
            status: "complete-but-held",
            outcome: "held-for-release",
            detail: `complete, and held unlanded: awaiting the crate release of ${engine}`,
            awaiting: [{ producer: engine, target: "crate" }],
          },
          publish: {
            status: "complete-but-draft",
            outcome: "change-draft",
            detail:
              "complete, and held as a draft until its pins can be released",
            awaiting: [
              { producer: engine, target: "crate" },
              { producer: schemas, target: "npm" },
            ],
          },
        },
      },
    });
    const byId = new Map(nodeViews(held).map((view) => [view.id, view]));
    const view = (id: string) => {
      const found = byId.get(id);
      if (found === undefined) throw new Error(`fixture has no ${id}`);
      return found;
    };
    for (const id of ["followup", "publish"]) {
      const node = view(id);
      expect(isUnhealthy(node.status)).toBe(false);
      expect(isOwnWorkLost(node.status)).toBe(false);
      // No reason line: a reason is what a card says about work going nowhere.
      expect(nodeReason(node)).toBeUndefined();
    }
    expect(awaitedLine(view("followup"))).toBe("awaits crate of engine");
    // The first entry, and a count of the rest: the line comes from `awaiting`,
    // since the draft's detail names no release at all.
    expect(awaitedLine(view("publish"))).toBe("awaits crate of engine +1");
    expect(awaitedReleases(view("publish"))).toEqual([
      { producer: engine, target: "crate" },
      { producer: schemas, target: "npm" },
    ]);
    // A node in any other status awaits nothing, whatever its result carries.
    expect(awaitedLine(view("foundation"))).toBeUndefined();
    expect(awaitedReleases(view("foundation"))).toEqual([]);
  });

  test("renders nothing for a detail with no projected graph", () => {
    // A run whose plan this host cannot read at all: the server serves `graph:
    // null` rather than inventing one, and the view shows nothing rather than a
    // graph it made up.
    const empty = parseRunDetail({ ...runDetail(LIVE_RUN), graph: null });
    expect(graphOf(empty)).toBeUndefined();
    expect(nodeViews(empty)).toEqual([]);
  });
});

describe("how a row names its launch", () => {
  test("names the session that launched a run, not the launch", () => {
    // The tag on a row, and the join is served on the row itself — so the list is
    // complete before a single run's detail, let alone its transcripts, is read.
    // Naming the *session* rather than the launch is the whole point: `just
    // orchestrate` mints a fresh launch id per run, so two runs of one planner
    // session share nothing but the session key and a row named by launch id would
    // tell an operator nothing about which planner it belonged to.
    const [first, second] = summaries;
    if (first?.launch === undefined || second?.launch === undefined)
      throw new Error("fixture");
    expect(launchLabel(first.launch)).toMatch(/^Codex session · 5e551040…$/);
    expect(launchLabel({ ...first.launch, launch_id: "f".repeat(32) })).toBe(
      launchLabel(first.launch),
    );
    expect(launchLabel(second.launch)).toMatch(/^Claude session · /);
  });

  test("names a launch whose session nothing can resolve by the launch itself", () => {
    // Every run launched before the launcher was detected, once its short-lived
    // provenance record has gone: with nothing left to name the session, the server
    // serves the launch id and an unknown launcher.
    const [first] = summaries;
    if (first?.launch === undefined) throw new Error("fixture");
    expect(
      launchLabel({ launch_id: first.launch.launch_id, launcher: "unknown" }),
    ).toBe("Unattributed launch · c0dec0de…");
    // And a run with no launch record at all is honestly unattributed, which is
    // what an e2e fixture and a bare `run-plan` genuinely are.
    expect(launchLabel(undefined)).toBe("Unattributed");
  });
});

describe("runState", () => {
  const word = (
    state: string,
    liveness?: string,
    statuses: Record<string, string> = { a: "done", b: "running" },
  ) =>
    runState({
      state,
      ...(liveness === undefined ? {} : { liveness }),
      statuses,
    });

  test("reads each ending the read API serves as its own word", () => {
    expect(word("settled", "DRIVER DEAD").word).toBe("Complete");
    expect(word("ended-failed", "DRIVER DEAD").word).toBe("Failed");
    expect(word("ended-stopped", "DRIVER DEAD").word).toBe("Stopped");
    expect(word("ended-unfinished", "UNDRIVEN").word).toBe("Unfinished");
  });

  test("reads a run waiting on a person as Waiting on you", () => {
    expect(word("paused", "DRIVER DEAD").word).toBe("Waiting on you");
    expect(word("active", "ACTIVE", { a: "waiting", b: "running" }).word).toBe(
      "Waiting on you",
    );
    // Paused before the driver: the decision is what the run needs first.
    expect(word("paused", "UNDRIVEN").word).toBe("Waiting on you");
  });

  test("reads a run nothing drives as Driver dead, whichever word says so", () => {
    expect(word("driver-dead", "DRIVER DEAD").word).toBe("Driver dead");
    expect(word("undriven", "UNDRIVEN").word).toBe("Driver dead");
    // A waiting node does not make a dead driver's run anything but dead.
    expect(word("driver-dead", "DRIVER DEAD", { a: "waiting" }).word).toBe(
      "Driver dead",
    );
  });

  test("reads a parked run as Idle and an active one as Running", () => {
    expect(word("parked", "PARKED").word).toBe("Idle");
    expect(word("active", "ACTIVE").word).toBe("Running");
  });

  test("reads the detail's own word before the status route has answered", () => {
    expect(word("active").word).toBe("Running");
    expect(word("parked").word).toBe("Idle");
    expect(word("driver-dead").word).toBe("Driver dead");
    expect(word("undriven").word).toBe("Driver dead");
    expect(word("active", undefined, { a: "waiting" }).word).toBe(
      "Waiting on you",
    );
    // The status route's liveness is the fresher reading where it has one.
    expect(word("active", "PARKED").word).toBe("Idle");
  });

  test("names each of the eight states by a word no other state shares", () => {
    const words = [
      word("settled"),
      word("ended-failed"),
      word("ended-stopped"),
      word("ended-unfinished"),
      word("paused"),
      word("driver-dead"),
      word("parked"),
      word("active"),
    ];
    expect(words.every((state) => state.known)).toBe(true);
    expect(new Set(words.map((state) => state.word)).size).toBe(8);
  });

  test("counts the failed nodes of a run that has not ended, beside its word", () => {
    const failing = { a: "failed", b: "failed", c: "running" };
    expect(word("active", "ACTIVE", failing)).toEqual({
      word: "Running",
      known: true,
      failed: 2,
    });
    expect(word("paused", "DRIVER DEAD", { ...failing, d: "waiting" })).toEqual(
      { word: "Waiting on you", known: true, failed: 2 },
    );
    expect(word("active", "ACTIVE").failed).toBe(0);
    // An ended run's word already says how it ended.
    expect(word("ended-failed", "DRIVER DEAD", failing).failed).toBe(0);
  });

  test("shows a word a later engine adds as served, rather than guessing", () => {
    expect(word("hibernating", "HIBERNATING")).toEqual({
      word: "hibernating",
      known: false,
      failed: 0,
    });
  });
});

describe("cardLines", () => {
  test("counts the lines a card carries, and is nothing for none", () => {
    expect(cardLines(undefined, undefined)).toEqual({});
    expect(cardLines("blocked by publish", undefined)).toEqual({ lines: 1 });
    expect(cardLines("blocked by publish", "awaits crate of engine")).toEqual({
      lines: 2,
    });
  });
});

describe("doneCount", () => {
  test("counts the done nodes out of all of them", () => {
    expect(
      doneCount([{ status: "done" }, { status: "failed" }, { status: "done" }]),
    ).toBe("2 of 3 done");
    expect(doneCount([])).toBe("0 of 0 done");
  });
});

describe("dependents", () => {
  test("names the plan nodes that depend on a node, in plan order, and none for a leaf", () => {
    const views = new Map(nodeViews(live).map((view) => [view.id, view]));
    expect(views.get("publish")?.dependents).toEqual(["approval", "abandoned"]);
    expect(views.get("approval")?.dependents).toEqual(["queued"]);
    expect(views.get("queued")?.dependents).toEqual([]);
  });
});
