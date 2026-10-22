import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { defaultResponder, telemetryHarness } from "../test/telemetry-harness";
import { App } from "./App";

beforeEach(() => window.history.replaceState(null, "", "/?list=runs"));
afterEach(cleanup);

function setupShutdown() {
  const sent: string[] = [];
  const { client } = telemetryHarness((url, init) => {
    if (url.pathname === "/api/v2/unwatched")
      throw new Error("run pages do not read unwatched");
    if (url.pathname === "/api/v2/shutdown") {
      sent.push(String(init?.body));
      return Response.json({
        api_version: 2,
        telemetry_schema_version: 23,
        observed_at: "2026-08-07T12:00:00Z",
        scope: "host",
        root: "/runs",
        grace_seconds: 120,
        forced: false,
        complete: true,
        runs: [],
        not_pushed: [],
        not_pushed_unread: null,
        rendered: "Host shut down",
      });
    }
    return defaultResponder(url);
  });
  render(<App client={client} />);
  return sent;
}

async function openShutdown() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Shut down the entire host" }),
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("list", { name: "Runs on this host" });
  return dialog;
}

test("offers only host shutdown and cancels without sending", async () => {
  const sent = setupShutdown();
  const dialog = await openShutdown();
  expect(
    screen.queryByRole("button", { name: "Shut down all my runs" }),
  ).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(sent).toEqual([]);
});

test("rejects fractional grace before sending host shutdown", async () => {
  const sent = setupShutdown();
  const dialog = await openShutdown();
  const grace = within(dialog).getByRole("spinbutton");
  await userEvent.clear(grace);
  await userEvent.type(grace, "1.5");
  expect(
    within(dialog).getByRole("button", { name: "Shut down the host" }),
  ).toBeDisabled();
  expect(sent).toEqual([]);
});

test("sends host shutdown with grace and shows its report", async () => {
  const sent = setupShutdown();
  const dialog = await openShutdown();
  const grace = within(dialog).getByRole("spinbutton");
  await userEvent.clear(grace);
  await userEvent.type(grace, "2");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Shut down the host" }),
  );
  expect(
    await screen.findByRole("alert", {
      name: "Shutdown of the entire host report",
    }),
  ).toHaveTextContent("Shutdown complete");
  expect(sent).toEqual(['{"scope":"host","grace":120,"force":false}']);
});
