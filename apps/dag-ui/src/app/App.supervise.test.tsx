import {
  cleanup,
  configure,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentsView, NodeAgents } from "../features/agents/AgentsView";
import {
  DASHBOARD_HISTORY_ID,
  DASHBOARD_TRANSCRIPT_TEXT,
  LIVE_PROJECT_NAME,
  LIVE_RUN,
  runAgents,
  runStatus,
} from "../test/fixtures";
import {
  defaultResponder,
  telemetryHarness,
  verbOf,
} from "../test/telemetry-harness";
import { App } from "./App";

const JOURNEY_TIMEOUT = { timeout: 60_000 };
configure({ asyncUtilTimeout: 10_000 });

/** The body a request carried, as the bytes the client put on the wire. */
const bodyOf = (init?: RequestInit): string =>
  typeof init?.body === "string" ? init.body : "";

describe("projects", JOURNEY_TIMEOUT, () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(cleanup);

  test("opens the newest project run directly and keeps host controls off the sidebar", async () => {
    const { client } = telemetryHarness();
    render(<App client={client} />);
    const navigation = await screen.findByRole("navigation", {
      name: "Projects",
    });
    await userEvent.click(
      await within(navigation).findByRole("button", {
        name: new RegExp(`^${LIVE_PROJECT_NAME}`),
      }),
    );
    await waitFor(() =>
      expect(window.location.search).toContain(`run=${LIVE_RUN}`),
    );
    expect(within(navigation).queryByText(/session/)).toBeNull();
    expect(
      within(navigation).queryByRole("button", { name: /Shut down/ }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("button", { name: "Runs" }),
    ).toBeNull();
  });
});

describe("supervising a run", JOURNEY_TIMEOUT, () => {
  beforeEach(() =>
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=overall`),
  );
  afterEach(cleanup);

  test("stops a run it owns on confirm, and a run another session owns only behind a second confirm naming the owner", async () => {
    const stops: string[] = [];
    let owned = false;
    const { client } = telemetryHarness((url, init) => {
      if (verbOf(url) === "stop") {
        const body = bodyOf(init);
        stops.push(body);
        if (!owned && body === '{"force":false}')
          return Response.json(
            {
              error: {
                code: "not_owner",
                message: `run ${LIVE_RUN} belongs to [codex:160c290a], not to this session`,
              },
            },
            { status: 409 },
          );
        return Response.json({
          ...runStatus(),
          run_id: LIVE_RUN,
          stopped: true,
          owner: owned ? "[mine]" : "[codex:160c290a]",
          forced: !owned,
          teardown: "nothing-to-stop",
        });
      }
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    const confirm = await screen.findByRole("dialog");
    expect(confirm).toHaveTextContent(`Stop ${LIVE_RUN}?`);
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Stop run" }),
    );
    // Refused, in the engine's words, naming the owner; the force is offered only now.
    const refused = await screen.findByRole("alert", { name: "Stop refused" });
    expect(refused).toHaveTextContent("409 not_owner");
    expect(refused).toHaveTextContent(
      `run ${LIVE_RUN} belongs to [codex:160c290a], not to this session`,
    );
    expect(stops).toEqual(['{"force":false}']);
    await userEvent.click(screen.getByRole("button", { name: "Force stop…" }));
    const second = await screen.findByRole("dialog");
    expect(second).toHaveTextContent(
      `Force-stop ${LIVE_RUN}, overriding [codex:160c290a]?`,
    );
    expect(second).toHaveTextContent("belongs to [codex:160c290a]");
    await userEvent.click(
      within(second).getByRole("button", {
        name: "Force stop, overriding [codex:160c290a]",
      }),
    );
    const forced = await screen.findByRole("alert", { name: "Stop receipt" });
    expect(forced).toHaveTextContent('"forced": true');
    expect(forced).toHaveTextContent('"owner": "[codex:160c290a]"');
    expect(stops).toEqual(['{"force":false}', '{"force":true}']);

    // A run the session owns: one confirm, and stopped.
    owned = true;
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Stop run",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("alert", { name: "Stop receipt" }),
      ).toHaveTextContent('"owner": "[mine]"'),
    );
    expect(stops.at(-1)).toBe('{"force":false}');
    expect(screen.queryByRole("button", { name: "Force stop…" })).toBeNull();
  });
});

describe("the agents a run launched", JOURNEY_TIMEOUT, () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(cleanup);

  test("lists a run's sessions by scope and attempt, and opens one to its transcript", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=agents`);
    const { client, fetch } = telemetryHarness();
    render(
      <AgentsView
        client={client}
        runId={LIVE_RUN}
        count={3}
        invalidations={0}
      />,
    );
    const panel = await screen.findByRole("region", { name: "Agents" });
    // The count the run detail carries, beside the listing it counts.
    await waitFor(() => expect(panel).toHaveTextContent("3 agents"));
    // Grouped by which launch of the run each session was written under, in
    // the engine's own scope order, and by attempt within a node's dispatches.
    const groups = within(panel)
      .getAllByRole("list")
      .map((list) => list.getAttribute("aria-label"));
    expect(groups.filter((name) => !name?.startsWith("Harness runs"))).toEqual([
      "Node dispatch · attempt 1",
      "Node dispatch · attempt 2",
      "Observer",
    ]);
    const first = within(panel).getByRole("list", {
      name: "Node dispatch · attempt 1",
    });
    // The labels a reader wants: the node the engine stamped, and the
    // repository's own `role`, under the word it chose; the harness runs by
    // their configured ids; and when it started.
    expect(first).toHaveTextContent("engineer-dashboard");
    expect(first).toHaveTextContent("node dashboard");
    expect(first).toHaveTextContent("role engineer");
    expect(first).toHaveTextContent("claude-code:alternate");
    expect(first).toHaveTextContent("started");
    // The second attempt's session recorded two harness runs, the second on
    // another harness.
    const retry = within(panel).getByRole("list", {
      name: "Node dispatch · attempt 2",
    });
    expect(
      within(retry).getAllByRole("button", { name: "Open transcript" }),
    ).toHaveLength(2);
    expect(retry).toHaveTextContent("codex");

    // Opening one: the conversation view the app has for a oneharness session,
    // asked for under the run the entry names and the harness run's history
    // id, and nothing else — no path on the host reaches the wire.
    await userEvent.click(
      within(first).getByRole("button", { name: "Open transcript" }),
    );
    expect(
      within(first).getByRole("button", { name: "Close transcript" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      await within(first).findByText(DASHBOARD_TRANSCRIPT_TEXT, {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(within(first).getByText("Oneharness conversation")).toBeVisible();
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).endsWith(
          `/api/v2/runs/${LIVE_RUN}/artifacts/${DASHBOARD_HISTORY_ID}`,
        ),
      ),
    ).toBe(true);
    await userEvent.click(
      within(first).getByRole("button", { name: "Close transcript" }),
    );
    expect(within(first).queryByText("Oneharness conversation")).toBeNull();
  });

  test("reads a review reply's drafting under its own heading, after the node's dispatches and the observer", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=agents`);
    const listing = runAgents(LIVE_RUN);
    const dispatch = listing.sessions.find(
      (session) => session.labels["onepipeline.scope"] === "node",
    );
    if (dispatch === undefined)
      throw new Error("the fixture lists no node dispatch");
    const replier = {
      ...dispatch,
      name: "replier-dashboard",
      history_session: "replier-dashboard-20260726T120000Z-4245",
      labels: {
        ...dispatch.labels,
        "onepipeline.scope": "review-reply",
        "onepipeline.attempt": "1",
      },
    };
    const { client } = telemetryHarness((url) =>
      verbOf(url) === "agents"
        ? Response.json({
            ...listing,
            sessions: [replier, ...listing.sessions],
          })
        : defaultResponder(url),
    );
    render(
      <AgentsView
        client={client}
        runId={LIVE_RUN}
        count={3}
        invalidations={0}
      />,
    );
    const panel = await screen.findByRole("region", { name: "Agents" });
    const reply = await within(panel).findByRole("list", {
      name: "Review reply author · attempt 1",
    });
    expect(reply).toHaveTextContent("replier-dashboard");
    expect(reply).toHaveTextContent("node dashboard");
    const groups = within(panel)
      .getAllByRole("list")
      .map((list) => list.getAttribute("aria-label"));
    expect(groups.filter((name) => !name?.startsWith("Harness runs"))).toEqual([
      "Node dispatch · attempt 1",
      "Node dispatch · attempt 2",
      "Observer",
      "Review reply author · attempt 1",
    ]);
  });

  test("shows a node's own sessions, and a node that dispatched nothing as none", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&node=dashboard&tab=agents`,
    );
    const { client } = telemetryHarness();
    const view = render(
      <NodeAgents
        client={client}
        runId={LIVE_RUN}
        nodeId="dashboard"
        invalidations={0}
      />,
    );
    const panel = await screen.findByRole("region", {
      name: "Agents of dashboard",
    });
    await waitFor(() =>
      expect(
        within(panel).getAllByRole("button", { name: "Open transcript" }),
      ).toHaveLength(3),
    );
    expect(within(panel).queryByText("Observer")).toBeNull();
    view.rerender(
      <NodeAgents
        client={client}
        runId={LIVE_RUN}
        nodeId="foundation"
        invalidations={0}
      />,
    );
    expect(
      await screen.findByRole("region", { name: "Agents of foundation" }),
    ).toHaveTextContent("No agents launched.");
  });
});
