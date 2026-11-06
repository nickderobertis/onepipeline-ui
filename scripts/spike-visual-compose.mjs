// SPIKE, nothing here lands: stack each phone and desktop shot into the one image a
// report entry names. Runs in the capture image, which carries the browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve("shots/local/spike-visual");
const shots = [
  ["before", "b1-cards"], ["after", "a1-cards"],
  ["after", "a2-dismiss-toast"], ["after", "a3-complete-toast"],
  ["after", "a4-reopen-greyed"], ["after", "a5-failed-write"],
  ["before", "b6-nav"], ["after", "a6-nav"],
  ["before", "b7-updates"], ["after", "a7-updates"],
  ["before", "b8-task"], ["after", "a8-task"],
];
mkdirSync(`${root}/report`, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
for (const [side, name] of shots) {
  const html = `${root}/report/${name}.html`;
  writeFileSync(
    html,
    `<!doctype html><style>
      body { margin: 0; padding: 24px 0; background: #2a2f3a; color: #fff; font: 600 30px sans-serif; text-align: center; }
      p { margin: 12px 0; } img { display: block; margin: 0 auto 28px; } .phone { width: 780px; } .desktop { width: 1200px; }
    </style>
    <p>Phone, 390 wide</p><img class="phone" src="../${side}/${name}-390x844.png">
    <p>Desktop, 1440 wide</p><img class="desktop" src="../${side}/${name}-1440x900.png">`,
  );
  await page.goto(`file://${html}`, { waitUntil: "load" });
  await page.screenshot({ path: `${root}/report/${name}.png`, fullPage: true });
}
await browser.close();
