import { join } from "node:path";
import { runDetailSchema } from "@onepipeline-ui/dag-model";
import { expect, test } from "@playwright/test";
import { runs } from "./fixture-facts";
import { startFixtureServer } from "./fixture-server";
import records from "./fixtures/check-visibility.json" with { type: "json" };
import { appendRecords } from "./load/journal";

test("the served view marks requirement and failing checks, including a follow read after settlement", async ({
  page,
}) => {
  const server = await startFixtureServer("check-visibility", []);
  try {
    const run = runs().live;
    appendRecords(
      join(server.workspace, "runs", run, "events.jsonl"),
      records.map((record, index) => ({
        ...record,
        v: 1,
        ts: new Date(Date.now() + index).toISOString(),
        stream: "check-visibility",
        seq: index + 1,
        labels: {
          ...("labels" in record ? record.labels : {}),
          run_id: run,
          node: "remote-open",
        },
        artifacts: [],
      })),
    );
    const response = await page.request.get(
      `${server.origin}/api/v2/runs/${run}`,
    );
    expect(response.ok()).toBe(true);
    const checks =
      runDetailSchema.parse(await response.json()).node_details["remote-open"]
        ?.verification.checks ?? [];
    await page.goto(`${server.origin}/?run=${run}&node=remote-open&tab=remote`);
    const table = page.getByRole("table", { name: "Remote checks" });
    await expect(
      table.getByRole("columnheader", { name: "Required", exact: true }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Blocks the merge?" }),
    ).toHaveCount(0);
    for (const record of records.filter(
      (record) => record.kind === "change-check",
    )) {
      const check = checks.find((check) => check.name === record.payload.name);
      expect(check).toBeDefined();
      if (check === undefined) throw new Error("check not served");
      expect(check.requirement).toBeTruthy();
      const row = table.getByRole("row").filter({
        has: page.getByRole("rowheader", { name: check.name, exact: true }),
      });
      const cell = row.getByRole("cell").last();
      await expect(cell).toHaveText(check.required ? "Required" : "Optional");
      await expect(cell).toHaveAttribute("title", check.requirement ?? "");
      await expect(
        cell.getByRole("img", {
          name: check.required ? "required" : "not required",
          exact: true,
        }),
      ).toBeVisible();
      await expect(row.getByRole("link", { name: check.name })).toHaveAttribute(
        "href",
        check.url ?? "",
      );
      if (
        record.payload.state === "failed" ||
        record.payload.state === "no-verdict"
      ) {
        await expect(row).toHaveClass("check-failing");
        await expect(row.getByRole("cell").nth(1)).toHaveCSS(
          "color",
          "rgb(248, 113, 113)",
        );
        expect(
          await row
            .getByRole("cell")
            .nth(1)
            .evaluate((cell) => getComputedStyle(cell, "::after").content),
        ).toContain("failing");
      } else {
        await expect(row).not.toHaveClass("check-failing");
      }
    }
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    const eventRows = page.getByRole("button", {
      name: "Open change-check",
      exact: true,
    });
    const count = await eventRows.count();
    const checkRecords = records.filter(
      (record) => record.kind === "change-check",
    );
    expect(count).toBeGreaterThanOrEqual(checkRecords.length);
    for (const [index, record] of records
      .filter((record) => record.kind === "change-check")
      .entries()) {
      await eventRows.nth(count - checkRecords.length + index).click();
      await expect(
        page.getByRole("region", { name: "Timeline item detail" }),
      ).toContainText(record.payload.name ?? "");
      await page
        .getByRole("button", { name: "Close detail", exact: true })
        .click();
    }
    for (const record of records.filter(
      (record) => record.kind === "planner-surface-queued",
    )) {
      await page
        .getByRole("button", {
          name: `Open ${record.payload.kind}: ${record.payload.message}`.replace(
            /\s+/g,
            " ",
          ),
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("region", { name: "Timeline item detail" }),
      ).toContainText(record.payload.message ?? "");
      await page
        .getByRole("button", { name: "Close detail", exact: true })
        .click();
    }
  } finally {
    await server.stop();
  }
});
