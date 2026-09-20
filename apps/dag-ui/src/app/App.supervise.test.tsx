import {
  act,
  cleanup,
  configure,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  channelQueue,
  DASHBOARD_HISTORY_ID,
  DASHBOARD_TRANSCRIPT_TEXT,
  HISTORY_RUN,
  LIVE_PROJECT,
  LIVE_PROJECT_NAME,
  LIVE_RUN,
  receipt,
  runAgents,
  runDetail,
  runStatus,
  unwatched,
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

  test("opens on the projects in the server's order, and a project opens to its runs", async () => {
    const { client } = telemetryHarness();
    render(<App client={client} />);
    // The landing: one card per group, the `(no project)` group among them, in the
    // order served rather than any order this app could compute.
    const cards = await screen.findByRole("list", { name: "Projects" });
    const names = within(cards)
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(names[0]).toContain(LIVE_PROJECT_NAME);
    expect(names[0]).toContain(LIVE_PROJECT);
    expect(names[0]).toContain("1 run · 1 running");
    expect(names[1]).toContain("(no project)");
    expect(names[1]).toContain("1 run · 1 complete");
    // The navigation lists the same groups, and says which list it is showing.
    const navigation = screen.getByRole("navigation", { name: "Projects" });
    expect(
      within(navigation).getByRole("button", { name: /observe-live-run/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "DAG nodes" })).toBeNull();

    // Opening the `(no project)` group: its page, from the listing it is served on.
    await userEvent.click(
      within(navigation).getByRole("button", { name: /\(no project\)/ }),
    );
    expect(window.location.search).toBe("?project=none");
    const runs = await screen.findByRole("list", {
      name: "Runs of (no project)",
    });
    const row = within(runs).getByRole("button", {
      name: `Open ${HISTORY_RUN}`,
    });
    expect(row).toHaveTextContent("complete");
    expect(row).toHaveTextContent("DRIVER DEAD");
    expect(row).toHaveTextContent("1 pending · 1 done");
    expect(row).toHaveTextContent("Last write");

    // And a named project, from its own route, with the unread surfaces the row
    // carries — then a run opened from it, with the page one step back.
    await userEvent.click(
      within(navigation).getByRole("button", { name: /observe-live-run/ }),
    );
    expect(window.location.search).toBe(
      `?project=${encodeURIComponent(LIVE_PROJECT)}`,
    );
    const liveRuns = await screen.findByRole("list", {
      name: `Runs of ${LIVE_PROJECT_NAME}`,
    });
    const liveRow = within(liveRuns).getByRole("button", {
      name: `Open ${LIVE_RUN}`,
    });
    expect(liveRow).toHaveTextContent("ACTIVE");
    expect(liveRow).toHaveTextContent("2 unread surfaces");
    await userEvent.click(liveRow);
    expect(await screen.findByText("Graph timeline")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("run")).toBe(
      LIVE_RUN,
    );
    expect(new URLSearchParams(window.location.search).get("project")).toBe(
      LIVE_PROJECT,
    );
    await userEvent.click(
      screen.getByRole("button", { name: `Back to ${LIVE_PROJECT_NAME}` }),
    );
    expect(
      await screen.findByRole("list", { name: `Runs of ${LIVE_PROJECT_NAME}` }),
    ).toBeInTheDocument();
  });

  test("keeps the flat run list one toggle away, and says when the projects cannot be read", async () => {
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/projects")
        return Response.json(
          { error: { code: "engine_error", message: "the root is gone" } },
          { status: 500 },
        );
      return defaultResponder(url);
    });
    render(<App client={client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "the root is gone",
    );
    await userEvent.click(screen.getByRole("button", { name: "Runs" }));
    expect(window.location.search).toBe("?list=runs");
    // The flat list, and its first run opened, exactly as before.
    const navigation = await screen.findByRole("navigation", {
      name: "DAG runs",
    });
    expect(
      within(navigation).getByRole("button", { name: RegExp(LIVE_RUN) }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Graph timeline")).toBeInTheDocument();
  });

  test("a project a bookmark names that the server does not hold says so", async () => {
    window.history.replaceState(null, "", "/?project=local-md%3Agone");
    const { client } = telemetryHarness();
    render(<App client={client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no such project",
    );
    expect(
      screen.getByRole("region", { name: "local-md:gone" }),
    ).toBeInTheDocument();
  });
});

describe("supervising a run", JOURNEY_TIMEOUT, () => {
  beforeEach(() =>
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=channel`),
  );
  afterEach(cleanup);

  test("reads the channel queue, claims the next surface, and raises one", async () => {
    const written: string[] = [];
    const { client } = telemetryHarness((url, init) => {
      if (init?.method === "POST")
        written.push(`${verbOf(url)} ${bodyOf(init)}`);
      return defaultResponder(url);
    });
    render(<App client={client} />);
    // The held surface is pending, the unread one waiting, the read one answered
    // — each with its kind, source, blocking flag and age.
    const pending = await screen.findByRole("region", {
      name: "Pending surfaces",
    });
    expect(pending).toHaveTextContent("ask-manager");
    expect(pending).toHaveTextContent("from sentinel");
    expect(pending).toHaveTextContent("blocking");
    expect(pending).toHaveTextContent("node dashboard");
    expect(pending).toHaveTextContent(/old/);
    const waiting = screen.getByRole("region", { name: "Waiting surfaces" });
    expect(waiting).toHaveTextContent("check-in");
    expect(waiting).toHaveTextContent("non-blocking");
    const answered = screen.getByRole("region", { name: "Answered surfaces" });
    expect(answered).toHaveTextContent("the gate went red 0");
    expect(screen.getByRole("region", { name: "Replies" })).toHaveTextContent(
      '"message": "carry on"',
    );
    expect(
      screen.getByRole("region", { name: "Command outcomes" }),
    ).toHaveTextContent("applied");

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const next = await screen.findByRole("alert", { name: "Next receipt" });
    expect(next).toHaveTextContent('"status": "surface"');
    expect(next).toHaveTextContent('"kind": "check-in"');
    expect(written).toContain("channel/next ");

    const surface = screen.getByRole("region", { name: "Surface" });
    await userEvent.type(within(surface).getByLabelText("Kind"), "finding");
    await userEvent.type(
      within(surface).getByLabelText("Message"),
      "from the browser",
    );
    await userEvent.click(
      within(surface).getByRole("button", { name: "Raise surface" }),
    );
    expect(
      await screen.findByRole("alert", { name: "Surface receipt" }),
    ).toHaveTextContent('"state": "queued"');
    expect(written).toContain(
      'channel/surface {"kind":"finding","message":"from the browser"}',
    );
  });

  test("composes a reply by shortcut, sends the editor's bytes verbatim, and shows the receipt or the refusal as returned", async () => {
    const sent: string[] = [];
    const { client } = telemetryHarness((url, init) => {
      if (verbOf(url) === "channel/reply") {
        const body = bodyOf(init);
        sent.push(body);
        if (body.includes("nonsense"))
          return Response.json(
            {
              error: {
                code: "refused",
                message:
                  "refused: the reply is malformed: unknown field `nonsense`, expected one of `version`, `author`, `completion`, `message`, `reason`, `commands` at line 1 column 12",
              },
            },
            { status: 422 },
          );
        return Response.json(receipt());
      }
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const composer = await screen.findByRole("region", { name: "Reply" });
    const shortcut = within(composer).getByLabelText("Shortcut");
    await userEvent.selectOptions(shortcut, "note");
    await userEvent.type(
      within(composer).getByLabelText("Node id"),
      "dashboard",
    );
    await userEvent.type(
      within(composer).getByLabelText("Text"),
      "measure the cold start too",
    );
    await userEvent.click(
      within(composer).getByRole("button", { name: "Compose envelope" }),
    );
    const editor = within(composer).getByLabelText("Envelope (sent as typed)");
    const composedEnvelope = {
      version: 3,
      commands: [
        {
          op: "note",
          id: "dashboard",
          addressee: "worker",
          text: "measure the cold start too",
        },
      ],
    };
    expect(editor).toHaveValue(JSON.stringify(composedEnvelope, null, 2));
    // The bytes on the wire are the editor's, whitespace and all — edited by
    // hand after the shortcut, so what reaches the engine is what is on screen.
    await userEvent.type(editor, " ");
    await userEvent.click(
      within(composer).getByRole("button", { name: "Send reply" }),
    );
    const shown = await within(composer).findByRole("alert", {
      name: "Reply receipt",
    });
    expect(shown).toHaveTextContent('"state": "delivered"');
    expect(shown).toHaveTextContent(
      "nothing is driving the run; adopt it for the reply to be read",
    );
    expect(sent).toEqual([`${JSON.stringify(composedEnvelope, null, 2)} `]);

    // A refusal is the engine's own words, unaltered.
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{"nonsense": 1}');
    await userEvent.click(
      within(composer).getByRole("button", { name: "Send reply" }),
    );
    const refused = await within(composer).findByRole("alert", {
      name: "Reply refused",
    });
    expect(refused).toHaveTextContent("422 refused");
    expect(refused).toHaveTextContent(
      "refused: the reply is malformed: unknown field `nonsense`, expected one of `version`, `author`, `completion`, `message`, `reason`, `commands` at line 1 column 12",
    );
    expect(sent[1]).toBe('{"nonsense": 1}');
  });

  test("attests a ready human action the graph shows", async () => {
    const attested: string[] = [];
    const { client } = telemetryHarness((url, init) => {
      if (verbOf(url) === "attest") {
        attested.push(bodyOf(init));
        return Response.json(receipt());
      }
      if (url.pathname.endsWith(`/runs/${LIVE_RUN}`)) {
        const detail = runDetail(LIVE_RUN);
        return Response.json({
          ...detail,
          conversations: [],
          graph: {
            ...detail.graph,
            decisions: [
              { id: "approval", kind: "human-action", unblocks: ["queued"] },
            ],
          },
        });
      }
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const actions = await screen.findByRole("region", {
      name: "Ready human actions",
    });
    expect(actions).toHaveTextContent("human-action");
    expect(actions).toHaveTextContent("unblocks queued");
    await userEvent.click(
      within(actions).getByRole("button", { name: "Attest approval" }),
    );
    expect(
      await within(actions).findByRole("alert", { name: "Attest receipt" }),
    ).toHaveTextContent('"state": "delivered"');
    expect(attested).toEqual(['{"reference":"approval"}']);
  });

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
    await screen.findByRole("region", { name: "Pending surfaces" });
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
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

  test("offers an adoption only when nothing is driving the run, and shows the pid answered", async () => {
    const { client } = telemetryHarness((url) => {
      if (verbOf(url) === "adopt")
        return Response.json({
          ...runStatus(),
          run_id: HISTORY_RUN,
          pid: 4242,
        });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    // The live run is ACTIVE: nothing to adopt.
    expect(await screen.findByLabelText("Liveness ACTIVE")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).toBeNull();

    window.history.replaceState(null, "", `/?run=${HISTORY_RUN}&view=channel`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(
      await screen.findByLabelText("Liveness DRIVER DEAD"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Adopt" }));
    expect(
      await screen.findByRole("alert", { name: "Adopt receipt" }),
    ).toHaveTextContent('"pid": 4242');
    expect(screen.getByText("Driver pid 4242")).toBeInTheDocument();
  });

  test("holds the watch as a stream and reads the unwatched badge for the session", async () => {
    let watching = false;
    const { client, sources } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/unwatched")
        return Response.json(unwatched(watching ? [] : [LIVE_RUN]));
      return defaultResponder(url);
    });
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=watch`);
    render(<App client={client} />);
    expect(await screen.findByLabelText("1 unwatched")).toHaveTextContent(
      "this run",
    );
    expect(screen.getByText(/Not watching/)).toBeInTheDocument();

    watching = true;
    const panel = screen.getByRole("region", { name: "Watch" });
    await userEvent.click(within(panel).getByRole("button", { name: "Watch" }));
    // The stream is held on the watch route under the reading's profile, and the
    // view says so.
    const stream = sources.find((source) => source.url.includes("/watch?"));
    expect(stream?.url).toContain(`/api/v2/runs/${LIVE_RUN}/watch?`);
    expect(stream?.url).toContain("timeout=none");
    expect(stream?.url).toContain("filter=detailed");
    expect(
      screen.getByText(`${LIVE_RUN} is being watched by this browser.`),
    ).toBeInTheDocument();
    act(() =>
      stream?.emit(
        "event",
        {
          watch: "event",
          event: {
            kind: "node-settled",
            ts: "2026-07-26T12:00:00Z",
            labels: { node: "docs" },
          },
        },
        "0",
      ),
    );
    act(() =>
      stream?.emit(
        "tick",
        {
          watch: "heartbeat",
          run_id: LIVE_RUN,
          unread: {
            count: 1,
            oldest_seconds: 12,
            kinds: [{ kind: "finding", count: 1 }],
          },
        },
        "1",
      ),
    );
    const frames = screen.getByRole("list", { name: "Watch frames" });
    expect(within(frames).getAllByRole("listitem")).toHaveLength(2);
    expect(frames).toHaveTextContent("node-settled");
    expect(frames).toHaveTextContent("docs");
    expect(frames).toHaveTextContent("1 unread, oldest 12s");
    // The badge re-reads once the server has this browser as the watcher.
    expect(await screen.findByLabelText("0 unwatched")).toBeInTheDocument();

    // The condition that ends the wait ends the hold, and the source with it.
    act(() =>
      stream?.emit(
        "returned",
        {
          watch: "return",
          run_id: LIVE_RUN,
          condition: "surface-waiting",
          exit: 0,
          cursor: `1:${LIVE_RUN}:40`,
          unread: { count: 1, oldest_seconds: 12, kinds: [] },
        },
        "2",
      ),
    );
    expect(
      screen.getByText("The wait ended: surface-waiting."),
    ).toBeInTheDocument();
    expect(stream?.closed).toBe(true);
    // Both toggles — the header's and the panel's — read the hold as released.
    for (const toggle of screen.getAllByRole("button", { name: "Watch" }))
      expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(frames).toHaveTextContent("returned");
  });

  test("shows every rendered read as the API served it", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=reads`);
    const { client } = telemetryHarness((url) => {
      if (
        verbOf(url) === "transcript" &&
        url.searchParams.get("node") === "publish"
      )
        return Response.json(
          {
            error: {
              code: "refused",
              message: "refused: run has recorded nothing for node 'publish'",
            },
          },
          { status: 422 },
        );
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const status = await screen.findByRole("region", { name: "Status" });
    expect(status).toHaveTextContent("ACTIVE");
    expect(status).toHaveTextContent("2 unread, oldest 40s");
    expect(status).toHaveTextContent(`${LIVE_RUN} ACTIVE 1/8 done`);

    await userEvent.click(screen.getByRole("tab", { name: "Results" }));
    expect(
      await screen.findByRole("region", { name: "Results" }),
    ).toHaveTextContent(`${LIVE_RUN} rendered results`);
    await userEvent.click(screen.getByRole("tab", { name: "Goals" }));
    expect(
      await screen.findByRole("region", { name: "Goals" }),
    ).toHaveTextContent(`${LIVE_RUN} rendered goals`);
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    const transcript = await screen.findByRole("region", {
      name: "Transcript",
    });
    await waitFor(() =>
      expect(transcript).toHaveTextContent(`${LIVE_RUN} transcript`),
    );
    await userEvent.selectOptions(
      within(transcript).getByLabelText("Node"),
      "publish",
    );
    expect(
      await within(transcript).findByRole("alert", {
        name: "Transcript refused",
      }),
    ).toHaveTextContent("refused: run has recorded nothing for node 'publish'");
    await userEvent.click(screen.getByRole("tab", { name: "Telemetry" }));
    expect(
      await screen.findByRole("region", { name: "Telemetry" }),
    ).toHaveTextContent('"schema_version": 2');
    await userEvent.click(screen.getByRole("tab", { name: "Host" }));
    expect(
      await screen.findByRole("region", { name: "Host" }),
    ).toHaveTextContent("no live dispatches");
  });

  test("keeps the composer on a run whose graph is still being planned", async () => {
    // A planning run has recorded no node yet; the channel is still a
    // post-launch route, so the composer is there.
    const { client } = telemetryHarness((url) => {
      if (url.pathname.endsWith(`/runs/${LIVE_RUN}`)) {
        const detail = runDetail(LIVE_RUN);
        return Response.json({
          ...detail,
          conversations: [],
          graph: {
            ...detail.graph,
            plan: { ...detail.graph.plan, tasks: [] },
            node_states: {},
            node_status: {},
            node_gated_by: {},
            node_control: {},
            node_results: {},
            decisions: [],
          },
          node_details: {},
        });
      }
      if (verbOf(url) === "channel")
        return Response.json({
          ...channelQueue(),
          surfaces: [],
          waiting: [],
          held: null,
          replies: [],
          outcomes: [],
        });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const composer = await screen.findByRole("region", { name: "Reply" });
    expect(within(composer).getByLabelText("Shortcut")).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Pending surfaces" }),
    ).toHaveTextContent("Nothing is waiting on an answer.");
  });
});

describe("the agents a run launched", JOURNEY_TIMEOUT, () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(cleanup);

  test("lists a run's sessions by scope and attempt, and opens one to its transcript", async () => {
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=agents`);
    const { client, fetch } = telemetryHarness();
    render(<App client={client} />);
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

  test("shows a node's own sessions, and a node that dispatched nothing as none", async () => {
    window.history.replaceState(
      null,
      "",
      `/?run=${LIVE_RUN}&node=dashboard&tab=agents`,
    );
    const { client } = telemetryHarness();
    render(<App client={client} />);
    const panel = await screen.findByRole("region", {
      name: "Agents of dashboard",
    });
    await waitFor(() =>
      expect(
        within(panel).getAllByRole("button", { name: "Open transcript" }),
      ).toHaveLength(3),
    );
    expect(within(panel).queryByText("Observer")).toBeNull();
    // Another node of the same run, whose dispatches wrote no session, opened
    // from the graph's own keyboard list.
    await userEvent.click(screen.getByRole("button", { name: /Graph/ }));
    await userEvent.click(
      within(await screen.findByRole("list", { name: "DAG nodes" })).getByRole(
        "button",
        { name: /^foundation:/ },
      ),
    );
    // The node's own tab strip — the run's views carry an Agents tab too.
    await userEvent.click(
      within(screen.getByRole("tablist", { name: "Node details" })).getByRole(
        "tab",
        { name: "Agents" },
      ),
    );
    expect(
      await screen.findByRole("region", { name: "Agents of foundation" }),
    ).toHaveTextContent("No agents launched.");
  });

  test("shows the union across a project's runs on its page, with the count on its row, and says when it cannot be read", async () => {
    window.history.replaceState(
      null,
      "",
      `/?project=${encodeURIComponent(LIVE_PROJECT)}`,
    );
    const { client } = telemetryHarness();
    render(<App client={client} />);
    const page = await screen.findByRole("region", {
      name: `Agents of ${LIVE_PROJECT_NAME}`,
    });
    await waitFor(() =>
      expect(
        within(page).getAllByRole("button", { name: "Open transcript" }),
      ).toHaveLength(4),
    );
    // The count the project group carries, on its row in the navigation and
    // beside the listing.
    expect(page).toHaveTextContent("3 agents");
    const navigation = screen.getByRole("navigation", { name: "Projects" });
    expect(
      within(navigation).getByRole("button", { name: /observe-live-run/ }),
    ).toHaveTextContent("3 agents");
    // The `(no project)` group has no id, so no agents route and no panel.
    await userEvent.click(
      within(navigation).getByRole("button", { name: /\(no project\)/ }),
    );
    await screen.findByRole("list", { name: "Runs of (no project)" });
    expect(screen.queryByRole("region", { name: /^Agents of/ })).toBeNull();
    cleanup();

    // A pointer file the server could not read is the engine's refusal, shown
    // as returned, and a count the server left off is not shown as a zero.
    window.history.replaceState(null, "", `/?run=${LIVE_RUN}&view=agents`);
    const refused = telemetryHarness((url) => {
      if (verbOf(url) === "agents")
        return Response.json(
          {
            error: {
              code: "refused",
              message: "invalid: cannot read the run's pointer file",
            },
          },
          { status: 422 },
        );
      if (url.pathname.endsWith(`/runs/${LIVE_RUN}`)) {
        const detail = runDetail(LIVE_RUN);
        return Response.json({
          ...detail,
          run: { ...detail.run, agent_count: undefined },
        });
      }
      return defaultResponder(url);
    });
    render(<App client={refused.client} />);
    const panel = await screen.findByRole("region", { name: "Agents" });
    expect(
      await within(panel).findByRole("alert", { name: "Agents refused" }),
    ).toHaveTextContent("cannot read the run's pointer file");
    expect(panel).not.toHaveTextContent("agents");
    expect(runAgents(LIVE_RUN).sessions).toHaveLength(3);
  });
});
