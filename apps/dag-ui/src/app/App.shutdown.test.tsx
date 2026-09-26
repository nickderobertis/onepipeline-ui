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
  CLAUDE_SESSION,
  CODEX_SESSION,
  HISTORY_RUN,
  LIVE_RUN,
  runList,
  unwatched,
} from "../test/fixtures";
import {
  defaultResponder,
  isRunList,
  selectedRuns,
  selectionOf,
  telemetryHarness,
} from "../test/telemetry-harness";
import { App } from "./App";

const JOURNEY_TIMEOUT = { timeout: 60_000 };
configure({ asyncUtilTimeout: 10_000 });

const envelope = {
  api_version: 2,
  telemetry_schema_version: 21,
  observed_at: "2026-07-26T12:00:00Z",
};

/** The acting session as the unwatched report names it: the live run's launcher. */
const acting = (key: string | null = CODEX_SESSION) => ({
  ...unwatched(),
  ...(key === null ? {} : { session_key: key }),
});

/** The engine's report of a shutdown over `runIds`, complete unless told otherwise. */
function report(
  scope: string,
  runIds: readonly string[],
  grace: number,
  forced: boolean,
  complete = true,
) {
  return {
    ...envelope,
    scope,
    root: "/runs",
    grace_seconds: grace,
    forced,
    complete,
    runs: runIds.map((run_id) => ({
      run_id,
      owner: run_id === LIVE_RUN ? "[mine]" : "[claude-code:5e5510c1]",
      forced_over_owner: run_id !== LIVE_RUN,
      dispatches:
        run_id === LIVE_RUN
          ? [
              {
                node: "dashboard",
                pid: 4242,
                interrupt: forced ? "not-asked" : "delivered",
                detail: "the running turn took the redirection",
                ended: complete ? "graceful" : "killed",
                waited_ms: 1500,
              },
            ]
          : [],
      teardown: "signalled",
      branches:
        run_id === LIVE_RUN
          ? [
              {
                identity: "work",
                branch: "feature/dashboard",
                result: complete ? "pushed" : "refused",
                remote: complete ? "origin" : null,
                commit: complete ? "abc1234" : null,
                detail: complete ? "preserved from /work" : "no such identity",
              },
            ]
          : [],
    })),
    not_pushed: complete ? [{ identity: "work", branch: "feature/other" }] : [],
    not_pushed_unread: complete ? null : "ONEVCS_HOME could not be read",
    rendered: `shutdown  scope ${scope}  grace ${grace}s\n`,
  };
}

/** A promise the test settles, for holding an answer open. */
function held<T>() {
  let release: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

interface Sent {
  readonly path: string;
  readonly body: string;
}

const isShutdown = (url: URL): boolean => url.pathname.endsWith("/shutdown");

const bodyOf = (init?: RequestInit): string =>
  typeof init?.body === "string" ? init.body : "";

/** Open the run's view and wait until its header can be acted on. */
async function openRun(runId: string): Promise<void> {
  window.history.replaceState(null, "", `/?list=runs&run=${runId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByLabelText(/^\d+ unwatched$/);
}

describe("shutdown", JOURNEY_TIMEOUT, () => {
  beforeEach(() => window.history.replaceState(null, "", "/?list=runs"));
  afterEach(cleanup);

  test("shuts one run down behind a dialog naming it and its owner, and shows the request in flight until the report", async () => {
    const sent: Sent[] = [];
    const answer = held<Response>();
    const { client } = telemetryHarness((url, init) => {
      if (url.pathname === "/api/v2/unwatched") return Response.json(acting());
      if (isShutdown(url)) {
        sent.push({ path: url.pathname, body: bodyOf(init) });
        return answer.promise;
      }
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await openRun(LIVE_RUN);

    // Cancel: the dialog names the run and its owner, force is off, and nothing
    // is sent.
    await userEvent.click(
      screen.getByRole("button", { name: "Shut down this run" }),
    );
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(`Shut down ${LIVE_RUN}?`);
    const named = within(dialog).getByRole("list", {
      name: "Runs this shutdown acts on",
    });
    expect(within(named).getAllByRole("listitem")).toHaveLength(1);
    expect(named).toHaveTextContent(
      `${LIVE_RUN} — owned by this session (Codex session · 5e551040…)`,
    );
    const force = within(dialog).getByRole("checkbox", {
      name: /whatever a worker had not committed is lost/,
    });
    expect(force).not.toBeChecked();
    expect(force).toHaveAccessibleName(
      "Force: skip the interrupt and the wait and go straight to the teardown — whatever a worker had not committed is lost.",
    );
    expect(
      within(dialog).getByRole("spinbutton", { name: "Grace" }),
    ).toHaveValue(10);
    expect(
      within(dialog).getByRole("combobox", { name: "Grace unit" }),
    ).toHaveValue("minutes");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual([]);

    // The keyboard path: open it, ticked force does not survive an Escape.
    screen.getByRole("button", { name: "Shut down this run" }).focus();
    await userEvent.keyboard("{Enter}");
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual([]);

    // Confirmed with a grace of ninety seconds and force off: one request.
    await userEvent.click(
      screen.getByRole("button", { name: "Shut down this run" }),
    );
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    const grace = within(dialog).getByRole("spinbutton", { name: "Grace" });
    await userEvent.clear(grace);
    await userEvent.type(grace, "90");
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Grace unit" }),
      "seconds",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Shut down run" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual([
      {
        path: `/api/v2/runs/${LIVE_RUN}/shutdown`,
        body: '{"grace":90,"force":false}',
      },
    ]);

    // In flight: named as still proceeding, with the grace it is waiting out.
    const status = screen.getByRole("region", { name: "Run shutdown" });
    expect(status).toHaveTextContent("Shutdown in progress");
    expect(status).toHaveTextContent("still waiting for the engine's answer");
    expect(status).toHaveTextContent(
      /Waiting out the 1 minute 30 seconds grace until \d{2}:\d{2}:\d{2}/,
    );
    expect(status).toHaveTextContent("scope run · grace 1 minute 30 seconds");
    expect(
      screen.getByRole("button", { name: "Shut down this run" }),
    ).toBeDisabled();
    expect(within(status).queryByRole("alert")).toBeNull();

    await act(async () =>
      answer.release(Response.json(report("run", [LIVE_RUN], 90, false))),
    );
    const done = await within(status).findByRole("alert", {
      name: "Run shutdown report",
    });
    expect(done).toHaveTextContent("Shutdown complete");
    expect(done).not.toHaveTextContent("Shutdown incomplete");
    expect(
      within(done).getByRole("list", { name: `Dispatches of ${LIVE_RUN}` }),
    ).toHaveTextContent(
      "dashboard (pid 4242): interrupt delivered; ended graceful after 1s",
    );
    expect(done).toHaveTextContent("Teardown: signalled");
    expect(
      within(done).getByRole("list", { name: `Branches of ${LIVE_RUN}` }),
    ).toHaveTextContent("work@feature/dashboard: pushed to origin at abc1234");
    expect(
      within(done).getByRole("list", { name: "Branches not pushed" }),
    ).toHaveTextContent("work@feature/other");
    expect(status).not.toHaveTextContent("Shutdown in progress");
    expect(sent).toHaveLength(1);
  });

  test("a run another session owns is named as such, sent with force as ticked, and the refusal shown in the server's words", async () => {
    const sent: Sent[] = [];
    const { client } = telemetryHarness((url, init) => {
      if (url.pathname === "/api/v2/unwatched") return Response.json(acting());
      if (isShutdown(url)) {
        sent.push({ path: url.pathname, body: bodyOf(init) });
        return Response.json(
          {
            error: {
              code: "not_owner",
              message: `run ${HISTORY_RUN} belongs to [claude-code:5e5510c1], not to this session`,
            },
          },
          { status: 409 },
        );
      }
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await openRun(HISTORY_RUN);
    await userEvent.click(
      screen.getByRole("button", { name: "Shut down this run" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      `${HISTORY_RUN} — owned by Claude session · 5e5510c1…`,
    );
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "not by this session, so the engine will refuse this shutdown and signal nothing",
    );
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Shut down run" }),
    );
    const refused = await screen.findByRole("alert", {
      name: "Run shutdown refused",
    });
    expect(refused).toHaveTextContent("Shutdown refused · 409 not_owner");
    expect(refused).toHaveTextContent(
      `run ${HISTORY_RUN} belongs to [claude-code:5e5510c1], not to this session`,
    );
    expect(sent).toEqual([
      {
        path: `/api/v2/runs/${HISTORY_RUN}/shutdown`,
        body: '{"grace":600,"force":true}',
      },
    ]);
    expect(
      screen.queryByText(/Shutdown complete|Shutdown incomplete/),
    ).toBeNull();
  });

  test("a request whose connection drops is named lost, never in progress and never a report", async () => {
    const answer = held<Response>();
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/unwatched") return Response.json(acting());
      if (isShutdown(url)) return answer.promise;
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await openRun(LIVE_RUN);
    await userEvent.click(
      screen.getByRole("button", { name: "Shut down this run" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Shut down run",
      }),
    );
    const status = screen.getByRole("region", { name: "Run shutdown" });
    expect(status).toHaveTextContent("Shutdown in progress");
    await act(async () => answer.fail(new TypeError("Failed to fetch")));
    const lost = await within(status).findByRole("alert", {
      name: "Run shutdown lost",
    });
    expect(lost).toHaveTextContent("Shutdown lost: no answer came back");
    expect(lost).toHaveTextContent(
      "The engine may still be carrying out the shutdown — check the runs",
    );
    expect(status).not.toHaveTextContent("Shutdown in progress");
    expect(status).not.toHaveTextContent(/Shutdown (complete|incomplete)/);
    // The control is offered again once nothing is out.
    expect(
      screen.getByRole("button", { name: "Shut down this run" }),
    ).toBeEnabled();
  });

  test("a server that answers with something other than its error envelope is lost, not refused", async () => {
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/unwatched") return Response.json(acting());
      if (isShutdown(url))
        return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await openRun(LIVE_RUN);
    await userEvent.click(
      screen.getByRole("button", { name: "Shut down this run" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Shut down run",
      }),
    );
    expect(
      await screen.findByRole("alert", { name: "Run shutdown lost" }),
    ).toHaveTextContent("Telemetry server returned invalid JSON");
    expect(
      screen.queryByRole("alert", { name: "Run shutdown refused" }),
    ).toBeNull();
  });

  test("shuts down every run this session owns, naming only those, with the listing's evidence while it runs", async () => {
    const sent: Sent[] = [];
    const answer = held<Response>();
    let recorded = false;
    const { client, sources } = telemetryHarness((url, init) => {
      if (url.pathname === "/api/v2/unwatched") return Response.json(acting());
      if (isShutdown(url)) {
        sent.push({ path: url.pathname, body: bodyOf(init) });
        return answer.promise;
      }
      if (isRunList(url) && recorded) {
        const rows = {
          ...runList,
          runs: runList.runs.map((row) =>
            row.run_id === LIVE_RUN
              ? { ...row, last_event: "host-shutdown", last_progress_at: 9 }
              : row,
          ),
        };
        const named = selectedRuns(url);
        return Response.json(
          named === undefined ? rows : selectionOf(rows, named),
        );
      }
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const host = await screen.findByRole("group", {
      name: "Shut down runs on this host",
    });
    await userEvent.click(
      within(host).getByRole("button", { name: "Shut down all my runs" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Shut down all my runs?");
    const named = await within(dialog).findByRole("list", {
      name: "Runs this shutdown acts on",
    });
    expect(
      within(named)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      `${LIVE_RUN} — owned by this session (Codex session · 5e551040…)`,
    ]);
    expect(dialog).not.toHaveTextContent(HISTORY_RUN);
    await userEvent.clear(within(dialog).getByRole("spinbutton"));
    await userEvent.type(within(dialog).getByRole("spinbutton"), "3");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Shut down my runs" }),
    );
    expect(sent).toEqual([
      {
        path: "/api/v2/shutdown",
        body: '{"scope":"mine","grace":180,"force":false}',
      },
    ]);
    const status = screen.getByRole("region", {
      name: "Shutdown of all my runs",
    });
    expect(status).toHaveTextContent("0 of 1 run has recorded their shutdown");

    // The engine records the run's shutdown; the stream says the row moved.
    recorded = true;
    act(() => sources[0]?.emit("run.changed", { run_id: LIVE_RUN }, "9"));
    const evidence = await within(status).findByRole("list", {
      name: "Recorded so far",
    });
    expect(evidence).toHaveTextContent(
      `${LIVE_RUN}: put down — host-shutdown recorded`,
    );
    expect(status).toHaveTextContent("1 of 1 run has recorded their shutdown");
    expect(status).toHaveTextContent("Shutdown in progress");

    await act(async () =>
      answer.release(Response.json(report("mine", [LIVE_RUN], 180, false))),
    );
    expect(
      await within(status).findByRole("alert", {
        name: "Shutdown of all my runs report",
      }),
    ).toHaveTextContent("Shutdown complete");
  });

  test("shuts the host down behind a dialog saying in words which runs other sessions own, and reads an incomplete report as incomplete", async () => {
    const sent: Sent[] = [];
    const { client } = telemetryHarness((url, init) => {
      if (url.pathname === "/api/v2/unwatched") return Response.json(acting());
      if (isShutdown(url)) {
        sent.push({ path: url.pathname, body: bodyOf(init) });
        return Response.json(
          report("host", [LIVE_RUN, HISTORY_RUN], 120, false, false),
        );
      }
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const host = await screen.findByRole("group", {
      name: "Shut down runs on this host",
    });
    await userEvent.click(
      within(host).getByRole("button", { name: "Shut down the entire host" }),
    );
    const dialog = await screen.findByRole("dialog");
    const others = await within(dialog).findByRole("list", {
      name: "Runs other sessions own",
    });
    expect(dialog).toHaveTextContent(
      "It acts on 1 run other sessions own, over their owners",
    );
    expect(others).toHaveTextContent(
      `${HISTORY_RUN} — owned by Claude session · 5e5510c1…`,
    );
    expect(
      within(dialog).getByRole("list", { name: "Runs this session owns" }),
    ).toHaveTextContent(`${LIVE_RUN} — owned by this session`);
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    await userEvent.clear(within(dialog).getByRole("spinbutton"));
    await userEvent.type(within(dialog).getByRole("spinbutton"), "2");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Shut down the host" }),
    );
    const done = await screen.findByRole("alert", {
      name: "Shutdown of the entire host report",
    });
    expect(done).toHaveTextContent("Shutdown incomplete");
    expect(done).not.toHaveTextContent("Shutdown complete");
    expect(done).toHaveTextContent(
      `${HISTORY_RUN} · owner [claude-code:5e5510c1] — another session's run, acted on over its owner`,
    );
    expect(done).toHaveTextContent("ended killed");
    expect(done).toHaveTextContent(
      "work@feature/dashboard: could not be preserved — no such identity",
    );
    expect(done).toHaveTextContent(
      "Other unpublished branches on this host: not read — ONEVCS_HOME could not be read. This is not a count of zero",
    );
    expect(sent).toEqual([
      {
        path: "/api/v2/shutdown",
        body: '{"scope":"host","grace":120,"force":false}',
      },
    ]);
  });

  test("an unattributed server owns nothing: its own runs are none, and every run on the host is another session's", async () => {
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/unwatched")
        return Response.json(acting(null));
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const host = await screen.findByRole("group", {
      name: "Shut down runs on this host",
    });
    await userEvent.click(
      within(host).getByRole("button", { name: "Shut down all my runs" }),
    );
    let dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/This session owns no run here/),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(
      within(host).getByRole("button", { name: "Shut down the entire host" }),
    );
    dialog = await screen.findByRole("dialog");
    const others = await within(dialog).findByRole("list", {
      name: "Runs other sessions own",
    });
    expect(within(others).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(dialog).queryByRole("list", { name: "Runs this session owns" }),
    ).toBeNull();
  });

  test("names every run on a paged listing before the host dialog can be confirmed, and withholds it when the session cannot be read", async () => {
    const extra = { ...runList.runs[1], run_id: "dag-ui-paged" };
    let unwatchedFails = true;
    const { client } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/unwatched")
        return unwatchedFails
          ? Response.json(
              { error: { code: "engine_error", message: "the root is gone" } },
              { status: 500 },
            )
          : Response.json(acting(CLAUDE_SESSION));
      if (isRunList(url) && selectedRuns(url) === undefined)
        return Response.json(
          url.searchParams.get("cursor") === "page-2"
            ? { ...runList, runs: [extra] }
            : { ...runList, next_cursor: "page-2" },
        );
      return defaultResponder(url);
    });
    render(<App client={client} />);
    const host = await screen.findByRole("group", {
      name: "Shut down runs on this host",
    });
    await userEvent.click(
      within(host).getByRole("button", { name: "Shut down the entire host" }),
    );
    let dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        /Which session this server acts as could not be read \(the root is gone\)/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Shut down the host" }),
    ).toBeDisabled();
    await userEvent.keyboard("{Escape}");

    unwatchedFails = false;
    await userEvent.click(
      within(host).getByRole("button", { name: "Shut down the entire host" }),
    );
    dialog = await screen.findByRole("dialog");
    const others = await within(dialog).findByRole("list", {
      name: "Runs other sessions own",
    });
    expect(others).toHaveTextContent(LIVE_RUN);
    // The second page was read for the dialog, so the run on it is named.
    const own = within(dialog).getByRole("list", {
      name: "Runs this session owns",
    });
    expect(own).toHaveTextContent(HISTORY_RUN);
    expect(own).toHaveTextContent("dag-ui-paged");
    expect(
      within(dialog).getByRole("button", { name: "Shut down the host" }),
    ).toBeEnabled();
  });

  test("refuses a grace that is not a whole number before anything can be sent", async () => {
    const { client, fetch } = telemetryHarness((url) => {
      if (url.pathname === "/api/v2/unwatched") return Response.json(acting());
      return defaultResponder(url);
    });
    render(<App client={client} />);
    await openRun(LIVE_RUN);
    await userEvent.click(
      screen.getByRole("button", { name: "Shut down this run" }),
    );
    const dialog = await screen.findByRole("dialog");
    const grace = within(dialog).getByRole("spinbutton", { name: "Grace" });
    await userEvent.clear(grace);
    expect(
      within(dialog).getByText(
        "The grace is a whole number of minutes or seconds, 0 or more.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Shut down run" }),
    ).toBeDisabled();
    expect(
      fetch.mock.calls.some(([input]) => String(input).includes("/shutdown")),
    ).toBe(false);
  });
});
