import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_INSTANT_MS } from "./capture-clock";
import { test } from "@playwright/test";

// Photographs only: deliberately no assertions, tests of engine behavior, or snapshots.
test.use({ viewport: { width: 1440, height: 900 } });
test("capture human actions throwaway proposal", async ({ page }) => {
  await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
  const output = process.env.SHOTS_OUT!;
  mkdirSync(output, { recursive: true });
  const shot = async (name: string) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(output, `${name}.png`), animations: "disabled" });
  };
  await page.goto("/?page=host");
  await page.getByRole("heading", { name: "Free space", exact: true }).waitFor();
  await page.getByRole("heading", { name: /^Unwatched runs: [0-9]+$/ }).waitFor();
  await shot("before-host");
  const open = async () => {
    await page.goto("/?page=host&mock=actions");
    await page.getByRole("region", { name: "Human actions mock" }).waitFor();
  };
  await open(); await shot("after-queue");
  for (const [field, value] of [["Kind","Task"],["Kind","Question"],["Plan","Access"],["State","Dismissed"],["Owner","Ended"],["Blocking","Nonblocking"],["Priority","P2"],["Scope","Node"]]) {
    await open(); await page.getByLabel(field, { exact:true }).selectOption(value);
    await shot(`after-filter-${field.toLowerCase()}-${value.toLowerCase()}`);
  }
  await open();
  for (const [field,value] of [["Kind","Question"],["Plan","Release"],["Owner","Active"],["Blocking","Blocking"],["Priority","P1"]]) await page.getByLabel(field,{exact:true}).selectOption(value);
  await shot("after-filters-combined");
  await page.getByRole("button",{name:/Q1 · Question/}).click();
  await page.getByText("announce-release",{exact:true}).click();
  await page.getByLabel("Inline answer",{exact:true}).fill("stable");
  await shot("after-question-detail");
  await page.getByRole("button",{name:"Send answer",exact:true}).click();
  await shot("after-answer-receipt");
  await open(); await page.getByRole("button",{name:/T2 · Task/}).click();
  await page.getByRole("button",{name:"Complete task",exact:true}).click(); await shot("after-complete-receipt");
  await open(); await page.getByRole("button",{name:/T3 · Task/}).click();
  await page.getByRole("button",{name:"Dismiss with reason",exact:true}).click(); await shot("after-dismiss-required");
  await page.getByLabel("Dismissal reason",{exact:true}).fill("Superseded by release archive");
  await page.getByRole("button",{name:"Dismiss with reason",exact:true}).click(); await shot("after-dismiss-receipt");
  await open(); await page.getByRole("button",{name:/T1 · Task/}).click();
  await page.getByRole("button",{name:"Approve board copy and key",exact:true}).click(); await shot("after-approval-required");
  await page.getByRole("checkbox",{name:/I approve board copy/}).check();
  await page.getByRole("checkbox",{name:/I approve board key/}).check();
  await page.getByRole("button",{name:"Approve board copy and key",exact:true}).click(); await shot("after-approval-receipt");
  for (const scene of ["list","report","receipts"]) {
    await page.goto(`/?mock=terminal&scene=${scene}`);
    await page.getByRole("heading",{name:`Human actions / ${scene}`,exact:true}).waitFor();
    await shot(`after-cli-${scene}`);
  }
});
