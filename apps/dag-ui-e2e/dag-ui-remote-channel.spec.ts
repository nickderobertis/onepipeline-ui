import { join } from "node:path";
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
    remote.getByRole("link", { name: "Pull request", exact: true }),
  ).toHaveAttribute("href", fixture().remote_open_pr);
  await expect(remote).toContainText("feature/remote-open");
  await expect(remote).toContainText("Not merged");
  await expect(remote).toContainText("Release");
  const table = remote.getByRole("table", { name: "Remote checks" });
  await expect(table.getByRole("row")).toHaveCount(6);
  // Each finished check's runtime is its own `completed_at` minus its own
  // `started_at`, as the host recorded them and the API served them.
  const served = await (
    await page.request.get(`/api/v2/runs/${runs().live}`)
  ).json();
  const checks: readonly {
    name: string;
    started_at?: string;
    completed_at?: string;
  }[] = served.node_details["remote-open"].verification.checks;
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
  for (const [name, status, conclusion, ran, required] of [
    ["gate", "completed", "success", runtime("gate"), "Required"],
    [
      "published-smoke",
      "completed",
      "failure",
      runtime("published-smoke"),
      "Optional",
    ],
    ["e2e", "in_progress", "—", /^(\d+h )?(\d+m )?\d+s · running$/, "Required"],
    // Queued: no start, so no runtime — never a zero.
    ["queued-check", "queued", "—", "", "Optional"],
    [
      "skipped-check",
      "completed",
      "skipped",
      runtime("skipped-check"),
      "Required",
    ],
  ] as const) {
    const row = table
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(row.getByRole("cell")).toHaveText([
      status,
      conclusion,
      ran,
      required,
    ]);
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
    .nth(2);
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
    // An unreadable start is no start: no runtime is made up for it.
    await expect(row.getByRole("cell")).toHaveText([
      "Not recorded",
      "skipped",
      "",
      "Required",
    ]);
    await expect(row.getByRole("link")).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

for (const width of [1440, 390]) {
  test(`pairs long channel replies by correlation and expands text before the envelope at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const questions = [0, 1, 2].map(
      (id) =>
        `Question ${id} ${"long preview ".repeat(30)}\nQuestion final sentinel ${id}`,
    );
    const answers = [0, 1].map(
      (id) =>
        `Answer ${id} ${"long preview ".repeat(30)}\nAnswer final sentinel ${id}`,
    );
    const followUp = `Follow-up answer ${"long preview ".repeat(30)}\nFollow-up final sentinel`;
    await page.goto(`/?run=${runs().history}&view=channel`);
    const surfaces = page.getByRole("listitem", { name: /^Surface \d+$/ });
    await expect(surfaces).toHaveCount(3);
    expect(
      await surfaces.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      ),
    ).toEqual(["Surface 2", "Surface 1", "Surface 0"]);
    for (const id of [0, 1, 2]) {
      const exchange = page.getByRole("listitem", {
        name: `Surface ${id}`,
        exact: true,
      });
      const messages =
        id === 0
          ? [questions[id], answers[id], followUp]
          : id === 1
            ? [questions[id], answers[id]]
            : [questions[id]];
      await expect(
        exchange.getByRole("group", { name: /^(Surface|Reply) \d+ message$/ }),
      ).toHaveCount(messages.length);
      for (const [index, text] of messages.entries()) {
        if (text === undefined)
          throw new Error("the recorded exchange has no expected text");
        const label =
          index === 0
            ? `Surface ${id} message`
            : index === 1
              ? `Reply ${1 - id} message`
              : "Reply 3 message";
        const message = exchange.getByRole("group", {
          name: label,
          exact: true,
        });
        const preview = message.getByText(`${text.split("\n")[0]}…`, {
          exact: true,
        });
        await expect(preview).toBeVisible();
        expect(
          await preview.evaluate(
            (element) => getComputedStyle(element).whiteSpace,
          ),
        ).toBe("nowrap");
        const secondaryMetadata =
          index === 0
            ? [
                message.getByText("from proposal", { exact: true }),
                message.getByText("non-blocking", { exact: true }),
                message.getByText(new RegExp(`^surface ${id} ·`)),
              ]
            : [message.getByRole("time")];
        await expect(
          message.getByText(
            index === 0 ? "finding" : `reply ${index === 1 ? 1 - id : 3}`,
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        for (const metadata of secondaryMetadata) {
          if (width === 390) await expect(metadata).toBeHidden();
          else await expect(metadata).toBeVisible();
        }
        const full = message.getByText(text, { exact: true });
        await expect(full).toBeHidden();
        const toggle = message.getByLabel(new RegExp(`^${label}:`));
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(full).toBeVisible();
        await expect(full).toHaveText(text);
        for (const metadata of secondaryMetadata)
          await expect(metadata).toBeVisible();
        if (index > 0) {
          const raw = message.getByRole("group", {
            name: /^Raw envelope for reply/,
          });
          const envelope = raw.getByText(
            JSON.stringify({ completion: false, message: text }, null, 2),
            { exact: true },
          );
          await expect(envelope).toBeHidden();
          await raw.getByText("Raw envelope", { exact: true }).click();
          await expect(envelope).toBeVisible();
          await expect(envelope).toContainText(
            index === 1
              ? `Answer final sentinel ${id}`
              : "Follow-up final sentinel",
          );
        }
      }
      if (id === 2) await expect(exchange).toContainText("Waiting for reply");
    }
    const fallback = page.getByRole("group", {
      name: "Reply 2 message",
      exact: true,
    });
    await expect(
      fallback.getByText("Reply without message…", { exact: true }),
    ).toBeVisible();
    await fallback.getByLabel(/^Reply 2 message:/).click();
    await expect(
      fallback.getByText("Reply without message", { exact: true }),
    ).toBeVisible();
    const raw = fallback.getByRole("group", {
      name: "Raw envelope for reply 2",
      exact: true,
    });
    const envelope = raw.getByText('{\n  "completion": false\n}', {
      exact: true,
    });
    await expect(envelope).toBeHidden();
    await raw.getByText("Raw envelope", { exact: true }).click();
    await expect(envelope).toBeVisible();
  });
}
