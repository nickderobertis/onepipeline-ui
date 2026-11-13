import { parseRunDetail, parseRunList } from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";
import { LIVE_RUN, runDetail, runList } from "../test/fixtures";
import {
  awaitedLine,
  awaitedReleases,
  graphOf,
  graphStateWord,
  isOwnWorkLost,
  isUnhealthy,
  launchLabel,
  nodeReason,
  nodeViews,
} from "./run-model";

const live = parseRunDetail(runDetail(LIVE_RUN));
const summaries = parseRunList(runList).runs;

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
    expect(byId.get("foundation")?.kind).toBe("lifecycle");
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
    // A graph holding only finished work awaiting releases is waiting, as the
    // engine reads one: neither settled nor failed.
    expect(
      graphStateWord({ a: "complete-but-held", b: "complete-but-draft" }),
    ).toBe("waiting");
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

describe("graphStateWord", () => {
  test("fails a graph with any failed or skipped node, before anything held", () => {
    expect(graphStateWord({ a: "done", b: "waiting", c: "skipped" })).toBe(
      "failed",
    );
    expect(graphStateWord({ a: "failed", b: "done" })).toBe("failed");
  });

  test("is complete only when every node is done, and for an empty graph", () => {
    expect(graphStateWord({ a: "done", b: "done" })).toBe("complete");
    expect(graphStateWord({})).toBe("complete");
  });

  test("leaves a graph with work outstanding waiting", () => {
    expect(graphStateWord({ a: "done", b: "running" })).toBe("waiting");
    expect(graphStateWord({ a: "blocked", b: "done" })).toBe("waiting");
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
