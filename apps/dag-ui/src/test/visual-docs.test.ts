import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoFile, repoPath } from "./repo-file";

/**
 * The drift gates over the visual-docs capture's pinned versions.
 *
 * Three versions decide whether the hash gate over this app's screenshots means
 * anything, and each of them is written down in more than one place: the browser
 * image (named by CI, derived by the local capture script), the screencomp release
 * (the reusable workflow's ref and the CLI version passed to it), and the viewport
 * matrix (declared for the journeys, restated as a toggle screencomp renders a
 * control for). A prose note asking a maintainer to keep copies in step is not a
 * gate; this is.
 *
 * The one that matters most is the image. The pre-push guard is what regenerates the
 * baseline CI compares against, so if the guard and CI render in different browsers
 * the committed baseline is a record of one machine's pixels and CI fails on
 * everything — which reads as a broken gate rather than as a skewed pin.
 *
 * Read as text rather than parsed, in this suite's established way: these are a YAML
 * workflow, a TOML config, a shell script and two manifests, and the assertions are
 * about the literals in them.
 */

/** The `@playwright/test` this repository pins, which every other copy is derived from. */
function playwrightVersion(): string {
  const manifest: { devDependencies?: Record<string, string> } = JSON.parse(
    repoFile("apps/dag-ui-e2e/package.json"),
  );
  const pinned = manifest.devDependencies?.["@playwright/test"];
  expect(pinned, "apps/dag-ui-e2e/package.json pins @playwright/test").toMatch(
    /^\d+\.\d+\.\d+$/,
  );
  return pinned as string;
}

/** The first column of every row of the `[[toggle]]` block for `key`. */
function toggleValues(config: string, key: string): readonly string[] {
  const block = config
    .split("[[toggle]]")
    .slice(1)
    .find((section) => section.includes(`key = "${key}"`));
  if (block === undefined)
    throw new Error(`screencomp.toml declares no ${key}`);
  const values = /values = \[([^\]]+)\]/.exec(block);
  if (values === null) throw new Error(`the ${key} toggle declares no values`);
  return [...(values[1] ?? "").matchAll(/"([^"]+)"/g)].map(
    ([, value]) => value ?? "",
  );
}

describe("the visual-docs capture's pinned versions", () => {
  const workflow = repoFile(".github/workflows/visual-docs.yml");
  const config = repoFile("screencomp.toml");

  it("renders CI in the image this repository pins @playwright/test to", () => {
    expect(workflow).toContain(
      `container: mcr.microsoft.com/playwright:v${playwrightVersion()}-noble`,
    );
  });

  it("leaves the local capture to derive that image rather than restate it", () => {
    // One literal in the tree and one only. The script builds the tag from the
    // manifest above, so bumping the dependency is the whole of bumping the image —
    // and a second literal here is exactly what the test above could not catch,
    // because it would agree with the manifest on the day it was written.
    const script = repoFile("scripts/visual-capture.sh");
    expect(script).toContain("apps/dag-ui-e2e/package.json");
    expect(script).not.toMatch(/mcr\.microsoft\.com\/playwright:v[\d.]/);
  });

  it("installs the screencomp release its reusable workflow is pinned to", () => {
    const used = /visual-docs-reusable\.yml@(v\d+\.\d+\.\d+)/.exec(
      workflow,
    )?.[1];
    const installed = /screencomp-version: (v\d+\.\d+\.\d+)/.exec(
      workflow,
    )?.[1];
    expect(used, "the workflow pins the reusable workflow").toBeDefined();
    expect(installed, "the workflow pins the CLI").toBeDefined();
    // The reusable workflow's internal composite actions float on the major tag, so
    // these two parting is a newer CLI — and a different verdict — arriving unasked.
    expect(installed).toBe(used);
  });

  it("gates strictly on drift", () => {
    expect(workflow).toContain("fail-on-drift: true");
  });

  it("declares exactly the viewport matrix the capture varies over", () => {
    const declared = [
      ...repoFile("apps/dag-ui-e2e/viewports.ts").matchAll(
        /^ {2}sized\((\d+), (\d+)\),$/gm,
      ),
    ].map(([, width, height]) => `${width}x${height}`);
    expect(declared.length).toBeGreaterThan(0);
    expect(toggleValues(config, "viewport")).toEqual(declared);
  });

  /**
   * Every picture `README.md` embeds is the capture the baseline recorded.
   *
   * This is the gate that keeps the document honest rather than merely current. The
   * committed baseline holds a SHA-256 per shot and nothing else, so a re-blessed
   * visual change moves those digests while the copies under `docs/screens/` sit
   * unchanged — a README showing a version of this app that no longer exists, with
   * nothing red anywhere. Comparing the file's own digest to the shot's closes that,
   * and it is why each picture keeps the capture's filename: `<screen>-<viewport>.png`
   * is what says which shot it is, so the mapping is derived rather than written down
   * a second time.
   */
  it("embeds the pictures the committed baseline recorded", () => {
    const baseline: {
      shots: { name: string; toggles: Record<string, string>; hash: string }[];
    } = JSON.parse(repoFile("shots/baseline/x86_64.json"));
    const pictures = [
      ...repoFile("README.md").matchAll(/\]\((docs\/screens\/([^)]+)\.png)\)/g),
    ];
    expect(pictures.length).toBeGreaterThan(1);
    for (const [, path, stem] of pictures) {
      const viewport = /-(\d+x\d+)$/.exec(stem ?? "")?.[1];
      expect(
        viewport,
        `${path} is named <screen>-<viewport>.png`,
      ).toBeDefined();
      const name = (stem ?? "").slice(0, -`-${viewport}`.length);
      const shot = baseline.shots.find(
        (candidate) =>
          candidate.name === name && candidate.toggles.viewport === viewport,
      );
      expect(shot, `the baseline records ${name} at ${viewport}`).toBeDefined();
      const digest = createHash("sha256")
        .update(readFileSync(repoPath(path ?? "")))
        .digest("hex");
      expect(
        digest,
        `${path} is not the shot the baseline recorded; re-copy it from the capture`,
      ).toBe(shot?.hash);
    }
  });

  it("varies no theme, because there is no second theme to vary", () => {
    // The document element is dark and there is no light variant and no switch
    // anywhere in this app, so a theme toggle would be a gallery control over a
    // dimension the capture cannot produce. Held against the committed baseline
    // rather than against the config alone, because the baseline is the record of
    // what was actually captured: every shot in it declares the viewport it was
    // taken at and nothing else.
    expect(config).not.toContain('key = "theme"');
    const declared = new Set(toggleValues(config, "viewport"));
    const baseline: { shots: { toggles: Record<string, string> }[] } =
      JSON.parse(repoFile("shots/baseline/x86_64.json"));
    expect(baseline.shots.length).toBeGreaterThan(0);
    for (const shot of baseline.shots) {
      expect(Object.keys(shot.toggles)).toEqual(["viewport"]);
      expect(declared).toContain(shot.toggles.viewport);
    }
  });
});
