import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultResponder, telemetryHarness } from "../test/telemetry-harness";
import { App } from "./App";

beforeEach(() => {
  window.history.replaceState(null, "", "/?page=host");
  // No clock advancement is needed: reads settle as promises and DOM events
  // drive the dialog. A newly introduced timer wait must fail this journey.
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function setupShutdown() {
  const sent: string[] = [];
  const { client } = telemetryHarness((url, init) => {
    if (url.pathname === "/api/v2/shutdown") {
      sent.push(String(init?.body));
      return Response.json({
        api_version: 2,
        telemetry_schema_version: 24,
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
  // Flush the harness's immediately answered reads through React, without
  // polling the DOM against a real clock.
  await act(async () => {
    render(<App client={client} />);
  });
  return sent;
}

function openShutdown() {
  fireEvent.click(
    screen.getByRole("button", { name: "Shut down the entire host" }),
  );
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByRole("list", { name: "Runs on this host" }),
  ).toBeInTheDocument();
  return dialog;
}

test("offers only host shutdown and cancels without sending", async () => {
  const sent = await setupShutdown();
  const dialog = openShutdown();
  expect(
    screen.queryByRole("button", { name: "Shut down all my runs" }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(sent).toEqual([]);
});

test("rejects fractional grace before sending host shutdown", async () => {
  const sent = await setupShutdown();
  const dialog = openShutdown();
  const grace = within(dialog).getByRole("spinbutton");
  fireEvent.change(grace, { target: { value: "1.5" } });
  expect(
    within(dialog).getByRole("button", { name: "Shut down the host" }),
  ).toBeDisabled();
  expect(sent).toEqual([]);
});

test("sends host shutdown with grace and shows its report", async () => {
  const sent = await setupShutdown();
  const dialog = openShutdown();
  const grace = within(dialog).getByRole("spinbutton");
  fireEvent.change(grace, { target: { value: "2" } });
  await act(async () => {
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Shut down the host" }),
    );
  });
  expect(
    screen.getByRole("alert", {
      name: "Shutdown of the entire host report",
    }),
  ).toHaveTextContent("Shutdown complete");
  expect(sent).toEqual(['{"scope":"host","grace":120,"force":false}']);
});
