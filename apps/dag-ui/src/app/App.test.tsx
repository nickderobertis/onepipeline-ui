import {
  type NodeDetail,
  parseRunDetail,
  parseRunTimeline,
  type SubscriptionView,
} from "@onepipeline-ui/dag-model";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  busyTimeline,
  HISTORY_RUN,
  LIVE_RUN,
  LONG_SESSION,
  longConversation,
  PR_URL,
  projectList,
  RUN_CHECK_IN_SESSION,
  runDetail,
  runList,
  runScopeTimeline,
  runTimeline,
  WORKER_SESSION,
  workerConversation,
  workerTurnsTimeline,
} from "../test/fixtures";
import {
  defaultResponder,
  isConversation,
  isRunDetail,
  isRunList,
  isTimeline,
  telemetryHarness,
} from "../test/telemetry-harness";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";

/** The rail row a reader would click, named by the words it puts on screen. */
const railRow = (name: RegExp) =>
  within(screen.getByRole("region", { name: "Node timeline" })).getByRole(
    "button",
    { name },
  );

/**
 * The transcript entry a reader would open, named by the words it puts on screen.
 *
 * The transcript is where an operator lands and where every recorded item is
 * listed in full; the timeline above it plots the same items and shows whichever
 * of them fit the compact line, so a journey that is about opening one item asks
 * the transcript for it rather than depending on that compaction.
 */
const openTranscript = async (name: RegExp) => {
  // Re-queried through the region on every attempt, never held across one: moving
  // between nodes remounts the whole view, and an element captured before that move
  // is a detached node whose click reaches nothing and reports nothing. `waitFor`
  // resolves to what its last attempt returned, which is the live element.
  const entry = await waitFor(() =>
    within(screen.getByRole("region", { name: "Node transcript" })).getByRole(
      "button",
      { name },
    ),
  );
  await userEvent.click(entry);
  await screen.findByRole("region", { name: "Timeline item detail" });
};

const detail = () =>
  screen.getByRole("region", { name: "Timeline item detail" });

/** The same pane, awaited: it arrives on a read behind the node view's own shell. */
const openedDetail = () =>
  screen.findByRole("region", { name: "Timeline item detail" });

/**
 * Whole-app jsdom journeys exceed vitest's 5 s default under the concurrent agent
 * dispatches this host runs. It covers the suite rather than the slowest few, because
 * host load decides which case crosses the line; sized only to catch a journey that has
 * stopped making progress.
 */
const JOURNEY_TIMEOUT = { timeout: 60_000 };

/**
 * Half this suite's waits poll for a chained telemetry read, which exceeds Testing
 * Library's 1 s default under load while still arriving. Set here rather than in the
 * shared setup because vitest isolates a test file's environment.
 */
configure({ asyncUtilTimeout: 10_000 });

/**
 * The two sessions the live fixture recorded at no node, by the span id that opens
 * each one: the orchestrator driving the graph, and the run's own check-in.
 */
const ORCHESTRATOR_SPAN = "dispatch-orchestrator-session";
const CHECK_IN_SPAN = `dispatch-${RUN_CHECK_IN_SESSION}`;

/** Nodes of the live fixture whose status every surface has to agree on. */
const SERVED_STATUSES: readonly { node: string; status: string }[] = [
  { node: "queued", status: "blocked" },
  { node: "abandoned", status: "skipped" },
  { node: "followup", status: "pending" },
  { node: "publish", status: "failed" },
];

describe("DAG application", JOURNEY_TIMEOUT, () => {
  // The graph is one reading of a run and no longer the one an empty address lands
  // on, so the journeys that are about it say so — exactly as an operator's own
  // bookmark of the graph does. The landing view has a journey of its own below.
  beforeEach(() => {
    window.history.replaceState(null, "", "/?list=runs&view=graph");
  });

  afterEach(cleanup);

  test("opens a node in its own view, reads its timeline, and returns", async () => {
    const { client } = telemetryHarness();
    render(<App client={client} />);
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(screen.getByText("publish").closest(".dag-node")).toHaveClass(
      "state-failed",
    );

    fireEvent.click(screen.getByRole("button", { name: "dashboard: running" }));
    // The node takes over the working area: the graph is gone, and a breadcrumb
    // stands where it was.
    expect(
      await screen.findByRole("region", { name: "Timeline for dashboard" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "DAG nodes" })).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Breadcrumb" }),
    ).toHaveTextContent("dashboard");

    // The rail comes from a second read, so waiting on the shell above would not say
    // the record everything below reads has landed.
    await screen.findByRole("region", { name: "Node timeline" });

    // The upstream visualization identifies each activity and keeps timing details
    // in its hover/focus tooltip rather than printing metadata beside every row.
    const worker = railRow(/engineer-dashboard/);
    fireEvent.mouseEnter(worker);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Duration: 48.0 s");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Status: completed");
    // Every category is a lane of the legend, and the timeline opens on one compact
    // line; expanding is what gives each of them a row of its own.
    const legend = screen.getByRole("list", { name: "Timeline legend" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
      // The member lanes are the run's own words, in the order the payload served
      // them — this host's shape, served by nothing built in here.
    ).toEqual([
      "Queued",
      "worker",
      "judge",
      "check-in",
      "pr-author",
      "llmlint",
      "monitor",
      "Verification",
      "Publication",
      "Lock waits",
      "Human wait",
    ]);
    await userEvent.click(railRow(/^Expand timeline$/));
    expect(railRow(/^judge/)).toBeInTheDocument();
    expect(railRow(/^llmlint/)).toBeInTheDocument();
    expect(railRow(/^check-in/)).toBeInTheDocument();
    expect(railRow(/^pr-author/)).toBeInTheDocument();
    expect(railRow(/^Lock waits/)).toBeInTheDocument();
    await userEvent.click(railRow(/^Collapse timeline$/));

    await userEvent.click(railRow(/engineer-dashboard/));
    await waitFor(() =>
      expect(window.location.search).toContain("event=dispatch-worker-session"),
    );
    expect(
      await within(detail()).findByText("Implementing the dashboard now"),
    ).toBeInTheDocument();
    // The conversation says which dispatch it belongs to, which role it played in
    // it, and which persona it ran — a judge transcript is unreadable without them.
    expect(
      within(detail()).getByText("Dispatch 1 · worker · engineer"),
    ).toBeInTheDocument();
    expect(
      within(detail()).getAllByRole("button", { name: "Bash tool details" }),
    ).toHaveLength(1);
    await userEvent.click(
      within(detail()).getByRole("button", { name: "Bash tool details" }),
    );
    expect(
      within(detail()).getByLabelText("Bash tool output"),
    ).toHaveTextContent('"matches": 1');
    expect(
      within(detail())
        .getByLabelText("Bash tool output")
        .querySelector(".hljs-number"),
    ).toHaveTextContent("1");

    // Escape closes on-demand detail first, preserving reading context; a second
    // Escape returns to the graph.
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByText("queued")).toBeInTheDocument();
    expect(window.location.search).not.toContain("node=");
  });

  test("states one status per node on every surface that shows one", async () => {
    const { client } = telemetryHarness();
    render(<App client={client} />);
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    const nodeList = screen.getByRole("list", { name: "DAG nodes" });
    for (const { node, status } of SERVED_STATUSES) {
      // The card the pointer reads.
      expect(screen.getByText(node).closest(".dag-node")).toHaveClass(
        `state-${status}`,
      );
      // The list the keyboard reads.
      expect(
        within(nodeList).getByRole("button", {
          name: new RegExp(`^${node}: ${status}\\b`),
        }),
      ).toBeInTheDocument();
    }

    // The run row above them carries the counts its trimmed sidebar row serves:
    // done, failed and running, counted on the server over that same derivation.
    const row = screen.getByRole("button", { name: new RegExp(LIVE_RUN) });
    for (const count of ["1 running", "1 done", "1 failed"])
      expect(row).toHaveTextContent(count);

    // And the node view each card opens.
    for (const { node, status } of SERVED_STATUSES) {
      // Re-queried per node: leaving the node view unmounts and remounts the list.
      fireEvent.click(
        within(screen.getByRole("list", { name: "DAG nodes" })).getByRole(
          "button",
          { name: new RegExp(`^${node}: ${status}\\b`) },
        ),
      );
      const view = await screen.findByRole("region", {
        name: `Timeline for ${node}`,
      });
      expect(view.querySelector(".node-view-facts")).toHaveTextContent(status);
      fireEvent.click(screen.getByRole("button", { name: /Graph/ }));
    }
  });

  test("keeps every card on the graph readable when a live update settles a node", async () => {
    // The patch a live update pushes serves the node settled, as the server folds
    // it once the executor records the settlement: done on every surface, and no
    // longer in flight, so no turn the run can address.
    const served = runDetail(LIVE_RUN);
    const { client, push } = telemetryHarness();
    render(<App client={client} />);
    // Asked for by role, which a card React Flow holds hidden does not answer to.
    // This environment's resize observer never reports, so a card is readable
    // here only if it is drawn at its size without waiting to be measured.
    expect(
      await screen.findByRole("article", { name: "dashboard: running" }),
    ).toBeVisible();

    act(() =>
      push("detail.patch", {
        run_id: LIVE_RUN,
        ops: [
          {
            p: ["run", "nodes"],
            v: served.run.nodes.map((node) =>
              node.node === "dashboard" ? { ...node, status: "done" } : node,
            ),
          },
          { p: ["graph", "node_states", "dashboard"], v: "done" },
          { p: ["graph", "node_status", "dashboard"], v: "done" },
          { p: ["graph", "node_control"], v: {} },
        ],
      }),
    );
    expect(
      await screen.findByRole("article", { name: "dashboard: done" }),
    ).toBeVisible();
    // Every other card came through the same update drawn, not just the one that moved.
    expect(
      screen.getByRole("article", { name: "publish: failed" }),
    ).toBeVisible();
  });

  test("still counts a run whose statuses the server could not fold", async () => {
    // When a run's authoritative journal will not fold, the server counts its nodes
    // from the tolerant telemetry index instead, whose statuses are an open string.
    // A trimmed sidebar row carries the running, done and failed counts alone, so
    // the row shows what it can count in the vocabulary it knows — and never a
    // status counted zero times.
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/projects")
        return Response.json({
          ...projectList,
          projects: projectList.projects.map((group) => ({
            ...group,
            runs: group.runs.map((run) =>
              run.run_id === LIVE_RUN
                ? {
                    ...run,
                    node_counts: { improvised: 2, running: 1, absent: 0 },
                  }
                : run,
            ),
          })),
        });
      return defaultResponder(url);
    });
    render(<App client={client} />);

    const row = await screen.findByRole("button", {
      name: new RegExp(LIVE_RUN),
    });
    expect(row).toHaveTextContent("1 running");
    expect(row).not.toHaveTextContent("absent");
  });

  test("leads a failed node's view with why it failed", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=publish`);
    const { client } = telemetryHarness();
    render(<App client={client} />);

    // The reason is the first thing in the view and announces itself, rather than
    // sitting behind an accordion entry called "Outcome" beside four other facts.
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This node failed: agent");
    expect(banner).toHaveTextContent("Deploy failed");
    expect(banner).toHaveTextContent("publication exited non-zero");
    expect(banner).toHaveTextContent("2");
    expect(
      banner.compareDocumentPosition(screen.getByRole("tab", { name: "Task" })),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test("leads a blocked node's view with what is holding it", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=queued`);
    const { client } = telemetryHarness();
    render(<App client={client} />);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This node is blocked");
    expect(banner).toHaveTextContent("Blocked by");
    expect(banner).toHaveTextContent("approval");
  });

  test("says nothing extra about a node that is making progress", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=followup`);
    const { client } = telemetryHarness();
    render(<App client={client} />);
    // Work that has not started has no problem to report, and a banner over it
    // would read as one.
    expect(
      await screen.findByRole("region", { name: "Timeline for followup" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("walks back to the graph from the breadcrumb button", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&node=dashboard&event=dispatch-judge-session`,
    );
    const { client } = telemetryHarness();
    render(<App client={client} />);
    // A bookmarked moment is restored, expanded, from the address alone.
    await screen.findByRole("region", { name: "Timeline for dashboard" });
    expect(
      await within(await openedDetail()).findByText(
        "The transcript is accessible",
      ),
    ).toBeInTheDocument();

    const back = screen.getByRole("button", { name: /Graph/ });
    back.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("obsolete")).toBeInTheDocument();
  });

  test("expands a session to the one turn a bookmark names", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&node=dashboard&event=worker-session-0`,
    );
    const { client } = telemetryHarness();
    render(<App client={client} />);
    // The address opens the matching long-form item in the detail panel.
    expect(await screen.findByLabelText("Item detail panel")).toBeVisible();
    expect(
      await within(detail()).findByText("Implementing the dashboard now"),
    ).toBeInTheDocument();
  });

  test("says how a live turn took a note, where the record says", async () => {
    // A manager's note through the engine that says how the running turn took it
    // — left to end, here — and one recorded before the engine said so, both on
    // the node the planner already redirected.
    const noted = parseRunTimeline(runTimeline(LIVE_RUN));
    const redirected = noted.spans.find((span) =>
      span.events.some((event) => event.id === "event-10"),
    );
    if (redirected === undefined) throw new Error("fixture lost event-10");
    const note = (id: string, turn?: "turn-end") => ({
      id,
      kind: "edit-committed",
      at: "2026-07-26T11:00:51.000Z",
      node_id: "dashboard",
      redirection: {
        reached: "worker" as const,
        ...(turn === undefined ? {} : { turn }),
        delivered: true,
        delivery: "live" as const,
        node_id: "dashboard",
      },
    });
    redirected.events.push(
      note("note-turn-end", "turn-end"),
      note("note-unsaid"),
    );
    const open = (event: string) => {
      window.history.replaceState(
        null,
        "",
        `/?run=${LIVE_RUN}&node=dashboard&event=${event}`,
      );
      const { client } = telemetryHarness((url) =>
        isTimeline(url) ? Response.json(noted) : defaultResponder(url),
      );
      render(<App client={client} />);
    };

    // The planner asked for the turn to be left to end, and the record says it was.
    open("note-turn-end");
    expect(
      await within(await openedDetail()).findByText(
        "Left to end — the note reached it as it ended",
      ),
    ).toBeVisible();
    expect(within(detail()).getByText("Turn")).toBeInTheDocument();
    expect(
      within(detail()).getByText(
        "Live — into the turn that was already running",
      ),
    ).toBeInTheDocument();
    cleanup();

    // A note recorded before the engine said how still opens as the delivery it
    // was, with no row claiming either way.
    open("note-unsaid");
    expect(
      await within(await openedDetail()).findByText(
        "Live — into the turn that was already running",
      ),
    ).toBeVisible();
    expect(within(detail()).queryByText("Turn")).toBeNull();
    expect(
      within(detail()).queryByText(/^Left to end|^Interrupted —/),
    ).toBeNull();
  });

  test("shows a verification, a publication, and an aggregate as themselves", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=foundation`);
    const { client } = telemetryHarness();
    render(<App client={client} />);

    await openTranscript(/just gate/);
    expect(
      await within(detail()).findByText("Verification record"),
    ).toBeVisible();
    expect(within(detail()).getByText("Full log")).toBeInTheDocument();
    expect(within(detail()).queryByText(/foundation\/gate\.log/)).toBeNull();

    await userEvent.click(railRow(/local\/example/));
    expect(
      await within(detail()).findByRole("link", {
        name: /github\.com\/example\/repo\/pull\/12/,
      }),
    ).toBeInTheDocument();
    // A PR event states the checks that were observed on it, not just its url.
    expect(within(detail()).getByText("Observed checks")).toBeInTheDocument();
    expect(within(detail()).getByText("unit")).toBeInTheDocument();

    // An item with no dedicated rendering still shows every field the timeline
    // recorded for it rather than an empty pane.
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await openTranscript(/^Open Lock waits/);
    expect(
      await within(detail()).findByText("1240 records"),
    ).toBeInTheDocument();
    expect(within(detail()).getByText("Reference")).toBeInTheDocument();
    // This is the one rendering that shows a record the run closed, so both of its
    // stamps are read as ages — and the moment itself stays on the element rather
    // than reaching the reader as the ISO string the journal wrote.
    const ages = within(detail()).getAllByText(/ ago$/);
    expect(ages).toHaveLength(2);
    expect(ages[0]).toHaveAttribute("datetime", "2026-07-26T11:00:15.000Z");
    expect(ages[1]).toHaveAttribute("datetime", "2026-07-26T11:02:35.000Z");
  });

  test("keeps a node whose recorded work is hundreds of sessions scannable", async () => {
    const dense = parseRunTimeline(busyTimeline(200));
    dense.spans.push({
      id: "step-dense",
      kind: "step",
      label: "Supervised conversations",
      parent_id: "node-dashboard",
      node_id: "dashboard",
      step_id: "supervision",
      started_at: "2026-07-26T11:01:01.000Z",
      ended_at: "2026-07-26T11:10:00.000Z",
      status: "done",
      events: [],
    });
    for (const span of dense.spans) {
      if (span.kind === "dispatch") span.parent_id = "step-dense";
    }
    const { client } = telemetryHarness((url) =>
      isTimeline(url) ? Response.json(dense) : defaultResponder(url),
    );
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    render(<App client={client} />);

    const rail = await screen.findByRole("region", { name: "Node timeline" });
    // The lifecycle step brackets the sessions rather than being one of them, so it
    // is the transcript that names it, not a lane plotted over its own contents.
    const transcript = screen.getByRole("region", { name: "Node transcript" });
    expect(
      within(transcript).getByRole("button", {
        name: /Lifecycle: Supervised conversations/,
      }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "Expand timeline" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(rail).getByRole("button", { name: "Expand timeline" }),
    );
    expect(
      within(rail).getByRole("button", { name: "Collapse timeline" }),
    ).toBeInTheDocument();
  });

  test("labels a worker dispatched after a retry request as the retry", async () => {
    const retried = parseRunTimeline(runTimeline(LIVE_RUN));
    const node = retried.spans.find(({ id }) => id === "node-dashboard");
    const worker = retried.spans.find(
      ({ id }) => id === "dispatch-worker-session",
    );
    if (node === undefined || worker === undefined)
      throw new Error("fixture lost dashboard work");
    node.events.push({
      id: "retry-requested-1",
      kind: "retry-requested",
      at: "2026-07-26T11:02:35.000Z",
      node_id: "dashboard",
    });
    retried.spans.push({
      ...worker,
      id: "dispatch-worker-retry",
      label: "engineer-dashboard",
      started_at: "2026-07-26T11:02:40.000Z",
      ended_at: "2026-07-26T11:03:00.000Z",
    });
    const { client } = telemetryHarness((url) =>
      isTimeline(url) ? Response.json(retried) : defaultResponder(url),
    );
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    render(<App client={client} />);

    const transcript = await screen.findByRole("region", {
      name: "Node transcript",
    });
    const retry = within(transcript).getByRole("article", {
      name: /worker \(engineer-dashboard\) · retry 1/,
    });
    // The retry is a second dispatch of the node, so it is grouped as its own.
    expect(retry).toHaveAttribute("data-dispatch-group", "Dispatch 4");
    expect(
      within(transcript).getByRole("article", {
        name: "worker (engineer-dashboard)",
      }),
    ).toHaveAttribute("data-dispatch-group", "Dispatch 1");
  });

  test("names what a failed node's attempts did not record", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=publish`);
    const { client } = telemetryHarness();
    render(<App client={client} />);

    // A gate that never reached an attestation, and a publication with no PR and
    // no observed checks: each absence is stated rather than left as a blank block
    // that reads like "all clear".
    await openTranscript(/branch push/);
    expect(
      await within(detail()).findByText("No readable log was recorded."),
    ).toBeInTheDocument();

    await userEvent.click(railRow(/^Publication/));
    expect(
      await within(detail()).findByText("No publication was recorded."),
    ).toBeInTheDocument();
    expect(
      within(detail()).getByText("No checks were observed on this node."),
    ).toBeInTheDocument();
  });

  test("says so when an opened turn is no longer in its transcript", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&node=dashboard&event=worker-session-0`,
    );
    // The timeline was folded from a history store that has since been rewritten,
    // so the turn it names is not in the transcript the server serves back.
    const { client } = telemetryHarness((url) =>
      isConversation(url)
        ? Response.json(longConversation())
        : defaultResponder(url),
    );
    render(<App client={client} />);
    expect(
      await screen.findByText(
        "This turn is no longer part of the recorded transcript.",
      ),
    ).toBeInTheDocument();
  });

  test("reports the graph timeline as unread rather than as an empty run", async () => {
    // The graph is on screen first; moving to Overall subscribes the run's
    // timeline, and until that answer arrives nothing has read it.
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
    let release: (response: Response) => void = () => {};
    let holding = false;
    const held = telemetryHarness((url) => {
      if (isTimeline(url) && holding)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return defaultResponder(url);
    });
    const view = render(<App client={held.client} />);
    await screen.findByText("dashboard");
    holding = true;
    await userEvent.click(screen.getByRole("tab", { name: "Overall" }));
    // "No timeline" would be a claim about a record nothing has read yet.
    expect(
      await screen.findByText("Loading the run's timeline…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("This run has recorded no timeline yet."),
    ).toBeNull();
    release(Response.json(runScopeTimeline(LIVE_RUN)));
    expect(
      await screen.findByRole("region", { name: "Graph timeline" }),
    ).toBeInTheDocument();
    view.unmount();

    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
    let failing = false;
    const refused = telemetryHarness((url) =>
      isTimeline(url) && failing
        ? Response.json(
            { error: { code: "unreadable", message: "Journal is corrupt" } },
            { status: 500 },
          )
        : defaultResponder(url),
    );
    render(<App client={refused.client} />);
    await screen.findByText("dashboard");
    failing = true;
    await userEvent.click(screen.getByRole("tab", { name: "Overall" }));
    expect(await screen.findByText("Timeline unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Journal is corrupt/)).toBeInTheDocument();
  });

  test("hands a long session to the reader a page at a time", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${HISTORY_RUN}&node=archive&event=dispatch-${LONG_SESSION}`,
    );
    const { client } = telemetryHarness();
    render(<App client={client} />);
    await screen.findByRole("region", { name: "Timeline for archive" });
    // Thirty recorded turns: the reader is shown a page and told what is left,
    // rather than handed the whole session on selection.
    expect(
      await within(await openedDetail()).findByText("Archive step 0"),
    ).toBeVisible();
    expect(within(detail()).getByText("Archive step 24")).toBeInTheDocument();
    expect(within(detail()).queryByText("Archive step 25")).toBeNull();

    await userEvent.click(
      within(detail()).getByRole("button", { name: /Show more of 30 turns/ }),
    );
    expect(
      await within(detail()).findByText("Archive step 29"),
    ).toBeInTheDocument();
  });

  test("reports a transcript the server cannot serve", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${HISTORY_RUN}&node=archive&event=dispatch-${LONG_SESSION}`,
    );
    const { client } = telemetryHarness((url) =>
      isConversation(url)
        ? Response.json(
            { error: { code: "unreadable", message: "History store is gone" } },
            { status: 503 },
          )
        : defaultResponder(url),
    );
    render(<App client={client} />);
    // The rail still reads; only the body of the session is missing, and that is
    // what has to be said rather than an empty card.
    expect(
      await screen.findByText("Transcript unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("History store is gone")).toBeInTheDocument();
  });

  test("reports a planner transcript the server cannot serve", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&view=overall&event=${ORCHESTRATOR_SPAN}`,
    );
    const { client } = telemetryHarness((url) =>
      isConversation(url)
        ? Response.json(
            { error: { code: "unreadable", message: "History store is gone" } },
            { status: 503 },
          )
        : defaultResponder(url),
    );
    render(<App client={client} />);
    expect(
      await screen.findByText("Transcript unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("History store is gone")).toBeInTheDocument();
  });

  test("reports a node timeline still on its way, then invites a selection", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
    let release: (response: Response) => void = () => {};
    let holding = false;
    const { client } = telemetryHarness((url) => {
      if (isTimeline(url) && holding)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await screen.findByText("dashboard");
    holding = true;
    fireEvent.click(screen.getByRole("button", { name: "dashboard: running" }));
    // The node view opens before its record has arrived. "No recorded timeline"
    // would be a claim about a journal nothing has read yet.
    expect(
      await screen.findByText("Loading the recorded timeline…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("This node has no recorded timeline yet."),
    ).toBeNull();

    // It arrives with no item named in the address, so the reading an operator
    // lands on is the transcript itself rather than an empty pane beside a plot.
    release(Response.json(runTimeline(LIVE_RUN)));
    expect(
      await screen.findByRole("region", { name: "Node transcript" }),
    ).toBeInTheDocument();
    expect(railRow(/engineer-dashboard/)).toBeInTheDocument();
  });

  test("says so when a node has no recorded timeline, and when the read fails", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=queued`);
    const { client } = telemetryHarness();
    const view = render(<App client={client} />);
    expect(
      await screen.findByText("This node has no recorded timeline yet."),
    ).toBeInTheDocument();
    view.unmount();

    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
    let refusing = false;
    const failing = telemetryHarness((url) =>
      isTimeline(url) && refusing
        ? Response.json(
            { error: { code: "unreadable", message: "Journal is corrupt" } },
            { status: 500 },
          )
        : defaultResponder(url),
    );
    render(<App client={failing.client} />);
    await screen.findByText("dashboard");
    refusing = true;
    fireEvent.click(screen.getByRole("button", { name: "dashboard: running" }));
    expect(await screen.findByText("Timeline unavailable")).toBeInTheDocument();
    expect(screen.getByText("Journal is corrupt")).toBeInTheDocument();
  });

  test("keeps the node's task, criteria, dependencies and gate reachable", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    const { client } = telemetryHarness();
    render(<App client={client} />);

    await userEvent.click(await screen.findByRole("tab", { name: "Task" }));
    expect(
      await screen.findByText(/Build the live dashboard/),
    ).toBeInTheDocument();
    // Plan schema 2 retired `done_when`: the bar is the `## Acceptance criteria`
    // section of the node's own task, which is the text the judge is handed, and
    // the tab shows that section alone rather than the whole prose again.
    await userEvent.click(
      screen.getByRole("tab", { name: "Acceptance criteria" }),
    );
    expect(
      await screen.findByText("Users can inspect transcripts"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Dependencies" }));
    // Each dependency with the status it holds, and what this node releases.
    expect(await screen.findByText("foundation (done)")).toBeInTheDocument();
    expect(
      screen.getByText("publish, followup", { exact: true }),
    ).toBeInTheDocument();
  });

  test("reads a steps-shaped node's task from the steps that carry it", async () => {
    // A lifecycle node that delegates to `steps` has no `task` prose of its own, so
    // reading only the node's own field left the Task tab blank for exactly the nodes
    // whose description is longest.
    window.history.replaceState(
      null,
      "",
      `/?run=${HISTORY_RUN}&node=corpus&tab=task`,
    );
    const { client } = telemetryHarness();
    render(<App client={client} />);

    expect(await screen.findByRole("tab", { name: "Task" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const prose = await screen.findByText(/Sweep the recorded corpus/);
    expect(prose).toHaveTextContent("sweep");
    expect(prose).toHaveTextContent("Confirm the sweep");
  });

  test("deep-links node tabs and moves across them with the keyboard", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&node=dashboard&tab=criteria`,
    );
    const { client } = telemetryHarness();
    render(<App client={client} />);
    const criteria = await screen.findByRole("tab", {
      name: "Acceptance criteria",
    });
    expect(criteria).toHaveAttribute("aria-selected", "true");
    criteria.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Dependencies" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(window.location.search).toContain("tab=dependencies");
  });

  test("hands the node's recorded pull request over as a link", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=foundation`);
    const { client } = telemetryHarness();
    const view = render(<App client={client} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Remote" }));
    const [link] = await screen.findAllByRole("link", { name: /Pull request/ });
    expect(link).toHaveAttribute("href", PR_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    view.unmount();

    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Remote" }));
    expect(
      screen.getByText("Publication").nextElementSibling,
    ).toHaveTextContent("Not recorded");
    expect(screen.queryByRole("link", { name: RegExp(PR_URL) })).toBeNull();
  });

  test.each<{
    name: string;
    publication: NonNullable<NodeDetail["publication"]>;
    expectedLinks: readonly string[];
    absentLinks: readonly string[];
  }>([
    {
      name: "local direct-merge",
      publication: {
        branch: "feature/local",
        base_branch: "main",
        merged: true,
        commit: "abc12345",
        commit_url: "https://github.com/example/repo/commit/abc12345",
      },
      expectedLinks: ["Commit abc12345"],
      absentLinks: ["Pull request"],
    },
    {
      name: "remote PR unmerged",
      publication: {
        pr_url: PR_URL,
        branch: "feature/remote",
        branch_url: "https://github.com/example/repo/tree/feature/remote",
        base_branch: "main",
        merged: false,
      },
      expectedLinks: ["Pull request", "feature/remote"],
      absentLinks: ["Commit"],
    },
    {
      name: "remote PR merged",
      publication: {
        pr_url: PR_URL,
        branch: "feature/remote",
        branch_url: "https://github.com/example/repo/tree/feature/remote",
        base_branch: "main",
        merged: true,
        commit: "def67890",
        commit_url: "https://github.com/example/repo/commit/def67890",
      },
      expectedLinks: ["Pull request", "Commit def67890"],
      absentLinks: ["feature/remote"],
    },
  ])(
    "renders the $name publication fixture",
    async ({ publication, expectedLinks, absentLinks }) => {
      window.history.replaceState(
        null,
        "",
        `/?run=${LIVE_RUN}&node=foundation`,
      );
      const served = parseRunDetail(runDetail());
      const foundation = served.node_details.foundation;
      if (foundation === undefined)
        throw new Error("fixture has no foundation detail");
      foundation.publication = publication;
      const { client } = telemetryHarness((url) =>
        isRunDetail(url) ? Response.json(served) : defaultResponder(url),
      );
      render(<App client={client} />);
      await userEvent.click(await screen.findByRole("tab", { name: "Remote" }));
      for (const name of expectedLinks) {
        expect(
          screen.getAllByRole("link", { name: new RegExp(name) }).length,
        ).toBeGreaterThan(0);
      }
      for (const name of absentLinks) {
        expect(
          screen.queryByRole("link", { name: new RegExp(name) }),
        ).toBeNull();
      }
    },
  );

  test("reads a recorded moment as words rather than as the stamp it was written as", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    const { client } = telemetryHarness();
    render(<App client={client} />);
    // The lock-wait rollup has no dedicated rendering, so it is the item whose every
    // recorded field reaches the reader — including the two stamps the detail used to
    // print straight out of the journal.
    await openTranscript(/^Open Lock waits/);
    expect(await within(detail()).findByText("Recorded at")).toBeVisible();
    expect(within(detail()).getByText("Duration")).toBeVisible();
    // Not one ISO stamp and not one raw second count anywhere in the pane.
    expect(detail().textContent).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(detail().textContent).not.toMatch(/\d+\.\d+s/);
  });

  test("reads only the selected run, and a transcript only when one is opened", async () => {
    const { client, fetch, views } = telemetryHarness();
    render(<App client={client} />);
    await screen.findByText("dashboard");

    const paths = (): URL[] =>
      fetch.mock.calls.map(
        (call: unknown[]) => new URL(String(call[0]), window.location.origin),
      );
    // Nothing is read off the read routes: the page holds what its one
    // subscription answered, which is the run being looked at and its detail —
    // not one for every listed run, and no timeline the graph does not show.
    expect(paths().some((url) => isRunDetail(url) || isTimeline(url))).toBe(
      false,
    );
    expect(views.at(-1)).toStrictEqual({
      type: "detail",
      run_id: LIVE_RUN,
      filter: "detailed",
    });
    expect(paths().some((url) => isConversation(url))).toBe(false);

    await userEvent.click(screen.getByRole("tab", { name: "Overall" }));
    await waitFor(() =>
      expect(views.at(-1)).toStrictEqual({
        type: "timeline",
        run_id: LIVE_RUN,
        scope: "run",
        filter: "detailed",
      }),
    );
    const runLevelConversationReads = paths().filter((url) =>
      isConversation(url),
    ).length;
    await userEvent.click(screen.getByRole("tab", { name: "Graph" }));
    await waitFor(() =>
      expect(views.at(-1)).toStrictEqual({
        type: "detail",
        run_id: LIVE_RUN,
        filter: "detailed",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "dashboard: running" }));
    await waitFor(() =>
      expect(views.at(-1)).toStrictEqual({
        type: "timeline",
        run_id: LIVE_RUN,
        scope: "node",
        node: "dashboard",
        filter: "detailed",
      }),
    );
    await openTranscript(/engineer-dashboard/);
    await waitFor(() =>
      expect(paths().filter((url) => isConversation(url))).toHaveLength(
        runLevelConversationReads + 1,
      ),
    );
  });

  test("shows launching sessions in header details and updates a row from its pushed frame", async () => {
    const { client, fetch, push } = telemetryHarness();
    render(<App client={client} />);
    await userEvent.click(await screen.findByText("Run details"));
    expect(
      await screen.findByText(/Launching session: Codex session/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation")).queryByText(/session/),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: RegExp(HISTORY_RUN) }));
    await waitFor(() =>
      expect(window.location.search).toContain(`run=${HISTORY_RUN}`),
    );
    expect(await screen.findByText("archive")).toBeInTheDocument();

    // Another run moving arrives as its one trimmed row, and the sidebar shows
    // it without the page reading the list, or the row, again.
    const listReads = () =>
      fetch.mock.calls.filter((call: unknown[]) =>
        isRunList(new URL(String(call[0]), window.location.origin)),
      ).length;
    const before = listReads();
    act(() =>
      push("run.changed", {
        row: {
          id: LIVE_RUN,
          name: LIVE_RUN,
          group: { project: "local-md:observatory", name: "observe-live-run" },
          kind: null,
          state: "settled",
          nodes: { total: 8, done: 7, failed: 1, running: 0 },
          updated_at: "2026-07-26T12:30:00.000Z",
        },
      }),
    );
    expect(
      await screen.findByRole("button", { name: RegExp(LIVE_RUN) }),
    ).toHaveTextContent("7 done");
    expect(listReads()).toBe(before);
  });

  test("shows live activity while leaving a settled transcript unread", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&view=overall&event=${ORCHESTRATOR_SPAN}`,
    );
    const { client, sources, fetch, push } = telemetryHarness();
    render(<App client={client} />);
    const turn = await screen.findByText("Coordinating the execution frontier");
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    const reads = (matches: (url: URL) => boolean): number =>
      fetch.mock.calls.filter((call: unknown[]) =>
        matches(new URL(String(call[0]), window.location.origin)),
      ).length;
    const conversations = reads(isConversation);

    // The header's activity line is the detail's `run.live_activity`, patched
    // with the rest of the detail.
    act(() =>
      push("detail.patch", {
        run_id: LIVE_RUN,
        ops: [
          {
            p: ["run", "live_activity"],
            v: [
              {
                event_id: "e14",
                node: "dashboard",
                at: Date.now(),
                kind: "tool",
                name: "Read",
                detail: "server.py",
                events: 12,
              },
            ],
          },
        ],
      }),
    );

    expect(await screen.findByText("dashboard: Read server.py")).toBeVisible();
    // Work elsewhere in the run cannot change a session that has stopped recording,
    // so the operator reading it is neither re-served it nor shown a skeleton: the
    // very element they were reading is still the one on the page, and nothing was
    // read to put the activity there.
    expect(reads(isConversation)).toBe(conversations);
    expect(reads(isRunDetail)).toBe(0);
    expect(screen.getByText("Coordinating the execution frontier")).toBe(turn);
    expect(screen.queryByText("Loading transcript…")).toBeNull();
  });

  test("appends a live transcript's next turn under the reader", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    let turns = 1;
    let release: ((response: Response) => void) | undefined;
    const { client, push } = telemetryHarness((url) => {
      if (isTimeline(url)) return Response.json(workerTurnsTimeline(turns));
      if (isConversation(url) && url.pathname.endsWith(WORKER_SESSION))
        // The re-read is held open, so what the panel shows *while* it is in flight
        // is asserted rather than raced past.
        return turns === 1
          ? Response.json(workerConversation(turns))
          : new Promise<Response>((resolve) => {
              release = resolve;
            });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await openTranscript(/engineer-dashboard/);
    const first = await within(await openedDetail()).findByText(
      "Implementing the dashboard now",
    );

    // The timeline patch says the session recorded another turn, which is what
    // asks for the open transcript again.
    turns = 2;
    act(() =>
      push("timeline.patch", {
        run_id: LIVE_RUN,
        scope: "node",
        node: "dashboard",
        ops: [{ p: ["spans"], v: workerTurnsTimeline(2).spans }],
      }),
    );
    await waitFor(() => expect(release).toBeDefined());

    // Mid-refetch: the turn already being read is untouched and nothing loading has
    // taken the panel's place.
    expect(within(detail()).getByText("Implementing the dashboard now")).toBe(
      first,
    );
    expect(screen.queryByText("Loading transcript…")).toBeNull();

    release?.(Response.json(workerConversation(2)));
    expect(
      await within(detail()).findByText("Dashboard turn 1 arrived"),
    ).toBeVisible();
    // Appended, not re-rendered from scratch: the first turn is the same element it
    // was before the second one landed.
    expect(within(detail()).getByText("Implementing the dashboard now")).toBe(
      first,
    );
  });

  test("keeps a transcript readable when a refresh of it fails", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    let turns = 1;
    let refuses = false;
    const { client, fetch, push } = telemetryHarness((url) => {
      if (isTimeline(url)) return Response.json(workerTurnsTimeline(turns));
      if (isConversation(url) && url.pathname.endsWith(WORKER_SESSION))
        return refuses
          ? Response.json(
              {
                error: { code: "unreadable", message: "History store is gone" },
              },
              { status: 503 },
            )
          : Response.json(workerConversation(turns));
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await openTranscript(/engineer-dashboard/);
    const first = await within(await openedDetail()).findByText(
      "Implementing the dashboard now",
    );
    const reads = (): number =>
      fetch.mock.calls.filter((call: unknown[]) =>
        isConversation(new URL(String(call[0]), window.location.origin)),
      ).length;
    const before = reads();
    const recorded = (count: number) =>
      act(() =>
        push("timeline.patch", {
          run_id: LIVE_RUN,
          scope: "node",
          node: "dashboard",
          ops: [{ p: ["spans"], v: workerTurnsTimeline(count).spans }],
        }),
      );

    refuses = true;
    turns = 2;
    recorded(2);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    // Refusing a read that is already in hand is nothing but microtask work, so one
    // macrotask boundary is past everything it was going to do to the page. Waiting
    // on the page itself cannot say this: what is being proven is that nothing there
    // moved at all.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The read it could not complete takes nothing away: what was readable stays
    // readable rather than being replaced by a report of the failed refresh.
    expect(within(detail()).getByText("Implementing the dashboard now")).toBe(
      first,
    );
    expect(screen.queryByText("Transcript unavailable")).toBeNull();

    // And the next read that does land is applied to that same page, so a refusal
    // costs the reader nothing more than the turn it did not deliver.
    refuses = false;
    turns = 3;
    recorded(3);
    expect(
      await within(detail()).findByText("Dashboard turn 2 arrived"),
    ).toBeVisible();
    expect(within(detail()).getByText("Implementing the dashboard now")).toBe(
      first,
    );
  });

  test("shows the loading state only for a transcript it has not read", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&node=dashboard`);
    let release: (response: Response) => void = () => {};
    const { client } = telemetryHarness((url) =>
      isConversation(url) && url.pathname.endsWith(WORKER_SESSION)
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : defaultResponder(url),
    );
    render(<App client={client} />);
    await openTranscript(/engineer-dashboard/);

    expect(
      await within(await openedDetail()).findByText("Loading transcript…"),
    ).toBeVisible();

    release(Response.json(workerConversation(1)));
    expect(
      await within(detail()).findByText("Implementing the dashboard now"),
    ).toBeVisible();
    expect(screen.queryByText("Loading transcript…")).toBeNull();
  });

  test("opens on the run as a whole when the address names no view", async () => {
    window.history.replaceState(null, "", "/?list=runs");
    const { client } = telemetryHarness();
    render(<App client={client} />);
    // The overall reading of the run is what an operator arrives for; the graph is
    // one tab away, and every deep link into it still opens where it points.
    expect(await screen.findByText("Graph timeline")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overall" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("list", { name: "DAG nodes" })).toBeNull();
    // The wall time it reports is a duration, not a second count to do sums on.
    expect(screen.getByText("Wall time").closest(".metric")).toHaveTextContent(
      "5s",
    );

    await userEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  /** The same detail, with the clock nothing could measure served as absent. */
  async function unmeasuredClock(answered: Response): Promise<Response> {
    // A parsed body is `any` until something says what it is, and the one thing
    // this needs to know is where the timing sits. Narrowed to that and nothing
    // else, so a change to the rest of the detail does not have to be restated
    // here — the contract's own parser is what holds the whole shape.
    const detail = (await answered.json()) as {
      run: { timing: Record<string, unknown> };
    };
    return Response.json({
      ...detail,
      run: {
        ...detail.run,
        timing: { ...detail.run.timing, wall_seconds: null, wall_ms: null },
      },
    });
  }

  test("says a run's clock is unmeasured rather than reporting no time at all", async () => {
    window.history.replaceState(null, "", "/?list=runs");
    // Schema 11 serves a timing nothing measured as null, and a server that could
    // not read the document that aggregates a run's clock serves every one of
    // them that way. `0s` would be the one reading that is a lie.
    const { client } = telemetryHarness((url) => {
      const answered = defaultResponder(url);
      if (!url.pathname.endsWith(`/runs/${runList.runs[0]?.run_id}`))
        return answered;
      return unmeasuredClock(answered);
    });
    render(<App client={client} />);
    expect(await screen.findByText("Graph timeline")).toBeInTheDocument();
    const wall = screen.getByText("Wall time").closest(".metric");
    expect(wall).toHaveTextContent("not measured");
    expect(wall).not.toHaveTextContent("0s");
  });

  test("opens the graph line into one row per node beside the run's own", async () => {
    const { client } = telemetryHarness();
    render(<App client={client} />);
    await screen.findByText("dashboard");
    // The view switcher is a real tab set now, and a tab set selects on the pointer
    // press rather than on the synthetic click that follows it — so this drives the
    // whole pointer sequence a person produces instead of dispatching one event.
    await userEvent.click(screen.getByRole("tab", { name: "Overall" }));
    await waitFor(() =>
      expect(window.location.search).toContain("view=overall"),
    );
    // Collapsed, the run is one line: no row of any kind is drawn yet.
    const line = await screen.findByRole("region", { name: "Graph timeline" });
    expect(
      screen.queryByRole("region", { name: "dashboard timeline" }),
    ).toBeNull();

    await userEvent.click(
      within(line).getByRole("button", { name: "Expand timeline" }),
    );
    // One row per plan node, and the run's own driving sessions beside them rather
    // than mixed into a node that did not dispatch them.
    const runRow = await screen.findByRole("region", {
      name: "Run-level timeline",
    });
    expect(
      within(runRow).getByRole("button", { name: /^Run-level · monitor/ }),
    ).toBeInTheDocument();
    expect(
      within(runRow).getByRole("button", { name: /^Run-level · check-in/ }),
    ).toBeInTheDocument();
    for (const node of ["foundation", "dashboard", "publish", "queued"]) {
      expect(
        screen.getByRole("region", { name: `${node} timeline` }),
      ).toBeInTheDocument();
    }
  });

  test("opens a node row again into the lanes its node view draws", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=overall`);
    const { client } = telemetryHarness();
    render(<App client={client} />);
    const line = await screen.findByRole("region", { name: "Graph timeline" });
    await userEvent.click(
      within(line).getByRole("button", { name: "Expand timeline" }),
    );
    const row = await screen.findByRole("region", {
      name: "dashboard timeline",
    });
    // Collapsed, the row is one line whatever it holds; the legend already names the
    // categories — the members under the run's own words, in the order the whole
    // payload first served each, the lint member among them.
    expect(
      within(row)
        .getAllByRole("listitem")
        .map((l) => l.textContent),
    ).toEqual([
      "check-in",
      "worker",
      "llmlint",
      "judge",
      "pr-author",
      "Lock waits",
      "Idle",
    ]);
    expect(within(row).getAllByTestId("timeline-lane")).toHaveLength(1);

    await userEvent.click(
      within(row).getByRole("button", { name: "Expand timeline" }),
    );
    expect(within(row).getAllByTestId("timeline-lane")).toHaveLength(7);
    // And a node the run never reached is one lane of recorded silence rather than
    // an empty row that could equally mean its record is missing.
    const queued = screen.getByRole("region", { name: "queued timeline" });
    await userEvent.click(
      within(queued).getByRole("button", { name: "Expand timeline" }),
    );
    expect(
      within(queued)
        .getAllByTestId("timeline-lane")
        .map((l) => l.dataset.laneId),
    ).toEqual(["idle"]);
    expect(
      within(queued).getByRole("button", { name: /^Idle · 4m 0s/ }),
    ).toBeInTheDocument();
  });

  test("opens a run-level session in the panel, and nothing before it is asked for", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=overall`);
    const { client, fetch } = telemetryHarness();
    render(<App client={client} />);
    const line = await screen.findByRole("region", { name: "Graph timeline" });
    const transcripts = (): string[] =>
      fetch.mock.calls
        .map(
          (call: unknown[]) => new URL(String(call[0]), window.location.origin),
        )
        .filter(isConversation)
        .map((url: URL) =>
          decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
        );
    // The run recorded two sessions at no node. Neither is read until one is opened:
    // the graph view is a plot of the record, not a download of it.
    expect(transcripts()).toEqual([]);

    await userEvent.click(
      within(line).getByRole("button", { name: "Expand timeline" }),
    );
    const runRow = screen.getByRole("region", { name: "Run-level timeline" });
    await userEvent.click(
      within(runRow).getByRole("button", { name: /^Run-level · check-in/ }),
    );
    // It opens in the same panel a node's own session opens in, with the turns
    // labelled by the role the plot named the segment with.
    const panel = await openedDetail();
    expect(
      await within(panel).findByText("Progress reported"),
    ).toBeInTheDocument();
    // Headed by the member word alone: the session's label is that same word, and
    // a session is not named twice for saying its name once.
    expect(
      within(panel).getByRole("heading", { name: /^check-in$/ }),
    ).toBeInTheDocument();
    expect(transcripts()).toEqual([RUN_CHECK_IN_SESSION]);
    expect(window.location.search).toContain(`event=${CHECK_IN_SPAN}`);

    // Escape closes it, exactly as it closes the node view's own panel.
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Timeline item detail" }),
      ).toBeNull(),
    );
  });

  test("draws a run that recorded no run-level session as a silent row", async () => {
    window.history.replaceState(null, "", `/?run=${HISTORY_RUN}&view=overall`);
    const { client } = telemetryHarness();
    render(<App client={client} />);
    const line = await screen.findByRole("region", { name: "Graph timeline" });
    await userEvent.click(
      within(line).getByRole("button", { name: "Expand timeline" }),
    );
    // Every session of this run belongs to a node, so the run-level row recorded
    // nothing — which is a row of idle, not a row that has been left out.
    const runRow = screen.getByRole("region", { name: "Run-level timeline" });
    expect(
      within(runRow).getByRole("button", { name: /^Idle · 2m 0s/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "archive timeline" }),
    ).toBeInTheDocument();
  });

  test("drills from a node's row into that node's own view", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=overall`);
    const { client } = telemetryHarness();
    render(<App client={client} />);
    const line = await screen.findByRole("region", { name: "Graph timeline" });
    await userEvent.click(
      within(line).getByRole("button", { name: "Expand timeline" }),
    );
    // Any segment of the row is the way in, silence included: the row is the node.
    await userEvent.click(
      within(
        screen.getByRole("region", { name: "foundation timeline" }),
      ).getByRole("button", { name: /^foundation · Verification/ }),
    );
    expect(
      await screen.findByRole("region", { name: "Timeline for foundation" }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain("node=foundation");
  });

  test("refreshes on demand and restores a bookmarked node selection", async () => {
    window.history.replaceState(null, "", `/?run=${HISTORY_RUN}&node=archive`);
    const { client, fetch } = telemetryHarness();
    render(<App client={client} />);
    expect(
      await screen.findByRole("region", { name: "Timeline for archive" }),
    ).toBeInTheDocument();

    const before = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(fetch.mock.calls.length).toBeGreaterThan(before),
    );

    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  test("shows the loading state, then an empty history", async () => {
    let release: (response: Response) => void = () => {};
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/projects")
        return Response.json({ ...runList, projects: [] });
      if (isRunList(url))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    expect(screen.getByText("Loading execution history…")).toBeInTheDocument();

    release(Response.json({ ...runList, runs: [] }));
    expect(await screen.findByText("No DAG runs found")).toBeInTheDocument();
  });

  test("keeps loading while a listed run's detail is still on its way", async () => {
    let release: (response: Response) => void = () => {};
    const { client } = telemetryHarness((url) => {
      // Only the selected run's detail is held back; everything else resolves.
      if (isRunDetail(url) && url.pathname.endsWith(LIVE_RUN))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    // Runs exist, so "no runs found" would be a lie; the view waits instead.
    expect(
      await screen.findByText("Loading execution history…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No DAG runs found")).toBeNull();

    release(Response.json(runDetail(LIVE_RUN)));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  test("surfaces a refused subscription and clears it when a refresh is served", async () => {
    let offline = true;
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/projects" && offline)
        return Response.json(
          { error: { code: "offline", message: "Telemetry offline" } },
          { status: 503 },
        );
      return defaultResponder(url);
    });
    render(<App client={client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Telemetry offline",
    );

    // Asking again subscribes from scratch, and a served answer is the app's
    // evidence that live telemetry recovered.
    offline = false;
    await userEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  test("surfaces a frame that fails contract validation, and applies nothing after it", async () => {
    const { client, push } = telemetryHarness();
    render(<App client={client} />);
    await screen.findByText("dashboard");

    // A peer that ships a frame the app does not accept must be reported, not
    // silently rendered from whatever survived: a row carrying a field the
    // contract does not name is such a frame.
    act(() =>
      push("run.changed", {
        row: {
          id: LIVE_RUN,
          name: LIVE_RUN,
          group: null,
          kind: null,
          state: "settled",
          nodes: { total: 1, done: 1, failed: 0, running: 0 },
          updated_at: "2026-07-26T12:30:00.000Z",
          session: "not a sidebar field",
        },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "contract validation",
    );
    expect(screen.getByText("dashboard")).toBeInTheDocument();
    // And a well-formed frame after it is not applied: the stream stopped.
    act(() =>
      push("run.changed", {
        row: {
          id: LIVE_RUN,
          name: LIVE_RUN,
          group: null,
          kind: null,
          state: "settled",
          nodes: { total: 8, done: 8, failed: 0, running: 0 },
          updated_at: "2026-07-26T12:31:00.000Z",
        },
      }),
    );
    expect(
      screen.getByRole("button", { name: RegExp(LIVE_RUN) }),
    ).not.toHaveTextContent("8 done");
  });

  test("surfaces a patch that does not apply rather than guessing at it", async () => {
    const { client, push } = telemetryHarness();
    render(<App client={client} />);
    await screen.findByText("dashboard");
    act(() =>
      push("detail.patch", {
        run_id: LIVE_RUN,
        ops: [{ p: ["graph", "no-such-member", "x"], v: 1 }],
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A patch could not be applied",
    );
    // What was on screen stays: the refused patch replaced nothing.
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  test("surfaces a dropped event stream, and clears it once frames flow again", async () => {
    const { client, sources, push } = telemetryHarness();
    render(<App client={client} />);
    await screen.findByText("dashboard");
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));

    act(() => sources.at(-1)?.fail());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Live telemetry stream disconnected",
    );
    act(() =>
      push("detail.patch", {
        run_id: LIVE_RUN,
        ops: [{ p: ["observed_at"], v: "2026-07-26T12:30:00Z" }],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("asks for nothing when the run it shows changes", async () => {
    const { client, fetch, push } = telemetryHarness();
    render(<App client={client} />);
    await screen.findByText("dashboard");
    const before = fetch.mock.calls.length;
    // A change to the open run arrives as its patch, which is applied to what is
    // on screen: no detail, timeline or list is read for it.
    act(() =>
      push("detail.patch", {
        run_id: LIVE_RUN,
        ops: [
          { p: ["graph", "node_states", "dashboard"], v: "done" },
          { p: ["graph", "node_status", "dashboard"], v: "done" },
          { p: ["graph", "node_control"], v: {} },
        ],
      }),
    );
    expect(
      await screen.findByRole("button", { name: /^dashboard: done\b/ }),
    ).toBeInTheDocument();
    expect(fetch.mock.calls.length).toBe(before);
  });

  test("stays quiet when the run it shows is removed", async () => {
    let removed = false;
    const { client, push } = telemetryHarness((url) => {
      if (removed && url.pathname.endsWith(LIVE_RUN))
        return Response.json(
          { error: { code: "run_not_found", message: "no recorded run" } },
          { status: 404 },
        );
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await screen.findByText("dashboard");

    // The run the page shows is swept away; the view follows the sidebar to the
    // run that remains instead of reporting a telemetry failure.
    removed = true;
    act(() => push("run.removed", { run_id: LIVE_RUN }));
    expect(await screen.findByText("archive")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("hands an unrenderable graph to the error boundary", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { client } = telemetryHarness((url) => {
      if (!isRunDetail(url)) return defaultResponder(url);
      const detail = runDetail(LIVE_RUN);
      // A dependency cycle: the layout rejects it, and no partial graph may be
      // shown in its place.
      const tasks: { deps?: string[] }[] = detail.graph.plan.tasks ?? [];
      if (tasks[0]) tasks[0].deps = ["dashboard"];
      return Response.json(detail);
    });
    render(
      <AppErrorBoundary>
        <App client={client} />
      </AppErrorBoundary>,
    );
    expect(
      await screen.findByText("The DAG view could not be displayed."),
    ).toBeInTheDocument();
    expect(screen.getByText("DAG contains a cycle")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  test("reports the Host page's listing it could not read, beside the reports it could", async () => {
    window.history.replaceState(null, "", "/?page=host");
    const { client } = telemetryHarness((url) =>
      isRunList(url)
        ? Response.json(
            { error: { code: "unreadable", message: "Runs root is gone" } },
            { status: 503 },
          )
        : defaultResponder(url),
    );
    render(<App client={client} />);
    const runs = await screen.findByRole("region", {
      name: "Runs on the host",
    });
    expect(await within(runs).findByRole("alert")).toHaveTextContent(
      "Listing unavailable: Runs root is gone",
    );
    // The host's own reports are still read and shown.
    expect(await screen.findByText(/^Unwatched runs: \d+/)).toBeInTheDocument();
  });

  test("drops a removed run and falls back to the remaining one", async () => {
    let removed = false;
    const { client, push, fetch } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/projects")
        return Response.json({
          ...projectList,
          projects: projectList.projects
            .map((group) => ({
              ...group,
              runs: group.runs.filter(
                (run) => !removed || run.run_id !== LIVE_RUN,
              ),
            }))
            .filter((group) => group.runs.length > 0),
        });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await screen.findByText("dashboard");

    // The row goes because its frame says so — the list is not read again.
    const before = fetch.mock.calls.filter((call: unknown[]) =>
      isRunList(new URL(String(call[0]), window.location.origin)),
    ).length;
    removed = true;
    act(() => push("run.removed", { run_id: LIVE_RUN }));
    expect(await screen.findByText("archive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RegExp(LIVE_RUN) })).toBeNull();
    expect(
      fetch.mock.calls.filter((call: unknown[]) =>
        isRunList(new URL(String(call[0]), window.location.origin)),
      ).length,
    ).toBe(before);
  });
});

test(
  "serves the timeline of whichever run is selected",
  JOURNEY_TIMEOUT,
  async () => {
    window.history.replaceState(null, "", `/?run=${HISTORY_RUN}&node=archive`);
    const { client } = telemetryHarness();
    render(<App client={client} />);
    // The archive run's own recorded work, not the live run's.
    expect(
      within(
        await screen.findByRole("region", { name: "Node timeline" }),
      ).getByRole("button", { name: /engineer-archive/ }),
    ).toBeInTheDocument();
    expect(runTimeline(HISTORY_RUN).spans).toHaveLength(3);
    cleanup();
  },
);

describe("the reading a viewer asks for", () => {
  /** The filter every read of the selected run was taken under, in order. */
  const filtersAsked = (views: readonly SubscriptionView[]): string[] =>
    views
      .filter((view) => view.type === "detail" || view.type === "timeline")
      .map((view) => ("filter" in view ? view.filter : undefined) ?? "");

  test(
    "switches between decisions and detailed activity, and says which is on",
    JOURNEY_TIMEOUT,
    async () => {
      window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=overall`);
      const { client, views } = telemetryHarness();
      render(<App client={client} />);
      await screen.findByRole("heading", { name: LIVE_RUN });

      const choice = (name: string) =>
        within(
          screen.getByRole("group", { name: "Level of detail" }),
        ).getByRole("button", { name });
      const decisions = choice("Decisions");
      const activity = choice("Detailed activity");

      // A reader who asked for nothing is shown everything, and the control says
      // so rather than leaving both settings looking equally selected.
      expect(activity).toHaveAttribute("aria-pressed", "true");
      expect(decisions).toHaveAttribute("aria-pressed", "false");
      await waitFor(() =>
        expect(filtersAsked(views).length).toBeGreaterThan(0),
      );
      expect(new Set(filtersAsked(views))).toEqual(new Set(["detailed"]));

      // Narrowing to the decisions is one click, and every read of the run is
      // taken again under the profile it names — so the graph, the timeline and
      // the stream can never be showing three different slices of one run.
      const before = filtersAsked(views).length;
      await userEvent.click(decisions);
      expect(decisions).toHaveAttribute("aria-pressed", "true");
      expect(activity).toHaveAttribute("aria-pressed", "false");
      await waitFor(() =>
        expect(filtersAsked(views).length).toBeGreaterThan(before),
      );
      expect(filtersAsked(views).slice(before)).toContain("planner");
      expect(filtersAsked(views).slice(before)).not.toContain("detailed");

      // And the reading is in the address, like every other selection: a reader
      // who narrowed their attention can send someone what they were looking at.
      expect(window.location.search).toContain("detail=decisions");
      // The run and the view they were on are untouched by it.
      expect(window.location.search).toContain(`run=${LIVE_RUN}`);
      expect(window.location.search).toContain("view=overall");

      // Back returns to the detailed reading, so the switch is undoable the way
      // the rest of the drill-down is.
      act(() => {
        window.history.back();
      });
      await waitFor(() =>
        expect(choice("Detailed activity")).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );
      cleanup();
    },
  );

  test(
    "opens on the decisions-level reading when the address names one",
    JOURNEY_TIMEOUT,
    async () => {
      window.history.replaceState(
        null,
        "",
        `/?run=${LIVE_RUN}&view=overall&detail=decisions`,
      );
      const { client, views } = telemetryHarness();
      render(<App client={client} />);
      await screen.findByRole("heading", { name: LIVE_RUN });
      await waitFor(() =>
        expect(filtersAsked(views).length).toBeGreaterThan(0),
      );
      // Every read from the first one: a bookmarked reading is not a reading the
      // app arrives at after showing the other one first.
      expect(new Set(filtersAsked(views))).toEqual(new Set(["planner"]));
      expect(
        within(
          screen.getByRole("group", { name: "Level of detail" }),
        ).getByRole("button", { name: "Decisions" }),
      ).toHaveAttribute("aria-pressed", "true");
      cleanup();
    },
  );

  test(
    "a reading the server has no profile for is reported, not silently widened",
    JOURNEY_TIMEOUT,
    async () => {
      window.history.replaceState(
        null,
        "",
        `/?run=${LIVE_RUN}&view=overall&detail=decisions`,
      );
      const { client } = telemetryHarness((url) => {
        if (!isRunDetail(url)) return defaultResponder(url);
        // What a server serves for a profile the run does not have. A viewer
        // must be told rather than shown an unnarrowed payload under the name
        // they asked for.
        return Response.json(
          {
            error: {
              code: "unknown_filter_profile",
              message: '"planner" is not a filter profile of this run',
            },
          },
          { status: 404 },
        );
      });
      render(<App client={client} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /not a filter profile/,
      );
      cleanup();
    },
  );
});

describe("a read that outlives the invalidation that arrived during it", () => {
  afterEach(cleanup);

  /**
   * A run-detail read of one run the test releases, so a stream can invalidate
   * faster than the server answers — which is the shape the operator hit: a read
   * taking over twenty seconds, another fired the moment it returned, and "Loading
   * execution history…" forever. Every other run reads at once, so what is held is
   * the reading under test and not the app.
   */
  const heldDetail = (runId: string) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken = 0;
    const harness = telemetryHarness(async (url) => {
      if (!isRunDetail(url) || !url.pathname.endsWith(`/${runId}`))
        return defaultResponder(url);
      taken += 1;
      await held;
      return defaultResponder(url);
    });
    return { ...harness, release: () => release(), reads: () => taken };
  };

  test(
    "renders a live run's detail rather than starving it",
    JOURNEY_TIMEOUT,
    async () => {
      window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
      const { client, release, reads } = heldDetail(LIVE_RUN);
      render(<App client={client} />);
      await screen.findByText("Loading execution history…");
      await waitFor(() => expect(reads()).toBe(1));
      // One subscription is out for the run, and nothing asks for it again while
      // it is: the run's changes arrive on its stream once it is answered.
      expect(reads()).toBe(1);

      release();
      expect(await screen.findByText("dashboard")).toBeInTheDocument();
      expect(screen.queryByText("Loading execution history…")).toBeNull();
    },
  );

  test(
    "discards a read of the run the reader has moved away from",
    JOURNEY_TIMEOUT,
    async () => {
      window.history.replaceState(null, "", `/?run=${HISTORY_RUN}&view=graph`);
      const { client, release } = heldDetail(LIVE_RUN);
      render(<App client={client} />);
      expect(await screen.findByText("archive")).toBeInTheDocument();

      // The reader opens the live run, whose subscription is held, and moves back
      // to the other run before it answers.
      await userEvent.click(
        await screen.findByRole("button", { name: RegExp(LIVE_RUN) }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: RegExp(HISTORY_RUN) }),
      );
      expect(await screen.findByText("archive")).toBeInTheDocument();

      // Only now does the subscription they moved away from answer. It describes
      // a different reading, and drawing it here would put one run's detail on
      // screen under another's name.
      release();
      await expect(
        waitFor(
          () => expect(screen.getByText("dashboard")).toBeInTheDocument(),
          { timeout: 2_000 },
        ),
      ).rejects.toThrow();
      expect(screen.getByRole("heading", { name: HISTORY_RUN })).toBeVisible();
    },
  );
});

describe("a run swept between the read that listed it and the read that fetched it", () => {
  afterEach(cleanup);

  /**
   * The one read failure that is not a failure, and it is still the detail route's
   * to swallow: the run-list route naming a requested id in `missing` tells the
   * *list* that a row has gone and says nothing about a detail read already out,
   * which still answers `404 run_not_found`. Both halves are asserted here, because
   * what makes the swallow safe is that it is matched on the code and not the
   * status — remove it and the first of these reports a race as a failure.
   */
  const detailAnswering = (error: { code: string; message: string }) =>
    telemetryHarness((url) => {
      if (!isRunDetail(url)) return defaultResponder(url);
      return Response.json({ error }, { status: 404 });
    });

  test("leaves the view showing no run rather than a failure", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
    const { client } = detailAnswering({
      code: "run_not_found",
      message: "no recorded run",
    });
    render(<App client={client} />);
    await screen.findByText("Loading execution history…");
    // Nothing to report: the race is what the next list resolves, and a banner
    // about it would describe the race rather than a problem.
    await expect(
      waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument(), {
        timeout: 2_000,
      }),
    ).rejects.toThrow();
  });

  test("still reports a read that really failed", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=graph`);
    const { client } = detailAnswering({
      code: "unknown_filter_profile",
      message: '"planner" is not a filter profile of this run',
    });
    render(<App client={client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /not a filter profile/,
    );
  });
});
