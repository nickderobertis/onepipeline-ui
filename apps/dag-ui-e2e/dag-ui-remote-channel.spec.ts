import { join } from "node:path";
import { runDetailSchema } from "@onepipeline-ui/dag-model";
import { expect, test } from "@playwright/test";
import { fixture, runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";
import { appendRecords } from "./load/journal";

test("Remote retains publication and release and follows each check's destination", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().live}&node=remote-open`);
  await page.getByRole("tab", { name: "Remote", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^(PR|Checks)$/ })).toHaveCount(0);
  const remote = page.getByRole("tabpanel", { name: "Remote", exact: true });
  await expect(
    // The corpus's change URLs are not GitHub's, so the link keeps the readable
    // name rather than a short id.
    remote.getByRole("link", { name: "Change request", exact: true }),
  ).toHaveAttribute("href", fixture().remote_open_pr);
  await expect(remote).toContainText("feature/remote-open");
  await expect(remote).toContainText("Not merged");
  await expect(remote).toContainText("Release");
  const table = remote.getByRole("table", { name: "Remote checks" });
  await expect(table.getByRole("row")).toHaveCount(6);
  // Each finished check's runtime is its own `completed_at` minus its own
  // `started_at`, as the host recorded them and the API served them.
  // Read by the schema the browser reads the detail with.
  const served = runDetailSchema.parse(
    await (await page.request.get(`/api/v2/runs/${runs().live}`)).json(),
  );
  const checks = served.node_details["remote-open"]?.verification.checks ?? [];
  const runtime = (name: string): string => {
    const check = checks.find((each) => each.name === name);
    if (check?.started_at === undefined || check.completed_at === undefined)
      throw new Error(`${name} recorded no finished run`);
    const seconds =
      (Date.parse(check.completed_at) - Date.parse(check.started_at)) / 1000;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds >= 60)
      throw new Error(
        `${name} ran ${seconds}s, which this reading cannot spell`,
      );
    return `${seconds}s`;
  };
  // One status word a check: its outcome once completed, its progress before.
  for (const [name, status, ran, required] of [
    ["gate", "passed", runtime("gate"), "Required"],
    ["published-smoke", "failed", runtime("published-smoke"), "Optional"],
    ["e2e", "running", /^(\d+h )?(\d+m )?\d+s · running$/, "Required"],
    // Queued: no start, so no runtime — never a zero.
    ["queued-check", "queued", "", "Optional"],
    ["skipped-check", "skipped", runtime("skipped-check"), "Required"],
  ] as const) {
    const row = table
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(row.getByRole("cell")).toHaveText([status, ran, required]);
    await expect(
      row.getByRole("cell").first().getByRole("img"),
    ).toHaveAccessibleName(status);
    if (name === "published-smoke") {
      await expect(row).toHaveClass("check-failing");
    } else {
      await expect(row).not.toHaveClass("check-failing");
    }
    const destination = await row.getByRole("link").getAttribute("href");
    const opened = page.waitForEvent("popup");
    await row.getByRole("link").click();
    const popup = await opened;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(destination);
    await expect(popup.getByText(/"onepipeline_version"/)).toBeVisible();
    await popup.close();
  }
  // A running check's runtime is the time since its own start, and it keeps
  // counting while the reader watches.
  const running = table
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "e2e", exact: true }) })
    .getByRole("cell")
    .nth(1);
  const started = Date.parse(
    checks.find((each) => each.name === "e2e")?.started_at ?? "",
  );
  const seconds = async () => {
    const shown = /^(?:(\d+)h )?(?:(\d+)m )?(\d+)s · running$/.exec(
      (await running.textContent()) ?? "",
    );
    if (shown === null) return Number.NaN;
    const [, hours = "0", minutes = "0", secs = "0"] = shown;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(secs);
  };
  const before = await seconds();
  expect(before).toBeGreaterThanOrEqual(
    Math.floor((Date.now() - started) / 1000) - 2,
  );
  await expect.poll(seconds, { timeout: 5_000 }).toBeGreaterThan(before);
  for (const tab of ["pr", "checks"]) {
    await page.goto(`/?run=${runs().live}&node=remote-open&tab=${tab}`);
    await expect(
      page.getByRole("tab", { name: "Remote", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  await page.goto(`/?run=${runs().live}&node=foundation`);
  await page.getByRole("tab", { name: "Remote", exact: true }).click();
  await expect(remote).toContainText(fixture().release.version);
  await expect(remote).toContainText("Merged");
});

test("Remote displays incomplete check records without inventing a status or link", async ({
  page,
}) => {
  const server = await startFixtureServer("legacy-check", []);
  try {
    const run = runs().live;
    // A recorded check from a writer that supplied its conclusion but no status or URL.
    appendRecords(join(server.workspace, "runs", run, "events.jsonl"), [
      {
        v: 1,
        ts: new Date().toISOString(),
        stream: "legacy-check-fixture",
        seq: 0,
        source: "vcs",
        kind: "change-check",
        labels: { run_id: run, node: "missing-artifact" },
        payload: {
          // llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] This deliberately malformed external record proves consumer recovery, not a normative producer shape. Pinned onevcs 0.56.3 publishes no change-check payload schema; its golden supplies the time/conclusion names, and url exercises the reader's optional address slot. A producer-conformance gate cannot validate intentionally invalid URL/time values or the older missing status.
          name: "legacy-check",
          required: true,
          conclusion: "skipped",
          url: "not a URL",
          started_at: "yesterday",
          completed_at: "2026-02-30T12:00:00Z",
          // llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
        },
        artifacts: [],
      },
    ]);
    await page.goto(
      `${server.origin}/?run=${run}&node=missing-artifact&tab=remote`,
    );
    const table = page.getByRole("table", { name: "Remote checks" });
    const row = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: "legacy-check", exact: true }),
    });
    // An unreadable start is no start: no runtime is made up for it. The
    // recorded conclusion is the check's outcome; no status is made up either.
    await expect(row.getByRole("cell")).toHaveText(["skipped", "", "Required"]);
    await expect(
      row.getByRole("cell").first().getByRole("img"),
    ).toHaveAccessibleName("skipped");
    await expect(row.getByRole("link")).toHaveCount(0);
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Open change-check", exact: true }),
    ).toBeVisible();
  } finally {
    await server.stop();
  }
});
