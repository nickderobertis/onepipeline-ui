// THROWAWAY visual spike (dag-ui-project-centric): the before/after pairs for the
// design document. `scripts/spike-visual.sh` runs it; `--grep after-` on this
// branch's build, `--grep before-` on the unchanged base's build. Not a test.
import { join, resolve } from "node:path";
import { type Page, test } from "@playwright/test";
import { CAPTURE_INSTANT_MS } from "./capture-clock";
import { runs } from "./fixture-facts";

const out = resolve(import.meta.dirname, "../..", process.env.SHOTS_OUT ?? "");

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after { animation-duration: 0s !important;
      animation-delay: 0s !important; transition: none !important; }`,
  });
  await page.waitForTimeout(1500);
}

const SHOTS: readonly {
  name: string;
  open: (page: Page) => Promise<void>;
}[] = [
  ...["sidebar", "host", "header", "nodelist", "timeline", "remote", "channel"].map(
    (view, index) => ({
      name: `after-${index + 1}-${view}`,
      open: async (page: Page) => {
        await page.goto(`/?spike=${view}`);
        await page.locator(".app-shell").waitFor();
        await page.mouse.move(0, 0);
      },
    }),
  ),
  {
    name: "before-2-host",
    open: async (page) => {
      await page.goto(`/?list=runs&run=${runs().live}&view=overall`);
      await page.getByRole("region", { name: "Graph timeline" }).waitFor();
      await page
        .getByRole("button", { name: /Shut down the entire host/ })
        .click();
      await page.getByRole("dialog").waitFor();
      await page.mouse.move(0, 0);
    },
  },
  {
    name: "before-5-timeline",
    open: async (page) => {
      await page.goto(`/?run=${runs().named}&view=overall`);
      const region = page.getByRole("region", { name: "Graph timeline" });
      await region.waitFor();
      await page.waitForTimeout(1000);
      const box = await region.boundingBox();
      if (box)
        await page.mouse.move(
          box.x + box.width * 0.55,
          box.y + box.height * 0.6,
        );
    },
  },
  {
    name: "before-6-remote",
    open: async (page) => {
      await page.goto(`/?run=${runs().live}&node=remote-open&tab=checks`);
      await page.getByRole("region", { name: /Timeline for remote-open/ }).waitFor();
      await page.mouse.move(0, 0);
    },
  },
];

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(CAPTURE_INSTANT_MS);
});

for (const shot of SHOTS) {
  test(shot.name, async ({ page }) => {
    await shot.open(page);
    await settle(page);
    await page.screenshot({ path: join(out, `${shot.name}.png`) });
  });
}
