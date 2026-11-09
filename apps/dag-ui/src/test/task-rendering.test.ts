import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { repoFile, repoPath } from "./repo-file";

/**
 * Every place this app shows a task renders it through `@onetaskgraph/ui`, so the
 * app holds no task renderer of its own to drift from the package's — no markdown
 * library declared beside it, and none of the components the package replaced.
 * The journeys prove what renders; this holds what the source may still say.
 */

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** Every source file under the app's `src`, by its path from the repository. */
function sources(directory = repoPath("apps/dag-ui/src")): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/u.test(name)
      ? [relative(repoPath("."), path).replaceAll("\\", "/")]
      : [];
  });
}

describe("task rendering is the shared package's", () => {
  const manifest = manifestSchema.parse(
    JSON.parse(repoFile("apps/dag-ui/package.json")),
  );
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };

  it("pins @onetaskgraph/ui exactly", () => {
    expect(declared["@onetaskgraph/ui"]).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("declares no markdown renderer of its own", () => {
    const renderers = Object.keys(declared).filter((name) =>
      /markdown|^remark|^rehype|^marked$|^micromark|^mdast/u.test(name),
    );
    expect(renderers).toEqual([]);
  });

  it("keeps none of what the package replaced", () => {
    const self = "apps/dag-ui/src/test/task-rendering.test.ts";
    const stale = sources()
      .filter((path) => path !== self)
      .filter((path) =>
        /\bTrackerLink\b|\btrackerProvider\b/u.test(repoFile(path)),
      );
    expect(stale).toEqual([]);
    // The node timeline's task prose and acceptance criteria are rendered, not
    // shown as monospace source.
    const timeline = repoFile(
      "apps/dag-ui/src/features/timeline/NodeTimelineView.tsx",
    );
    expect(timeline).not.toMatch(
      /<pre>\s*\{\s*(taskProse|acceptanceCriteria)\(/u,
    );
    expect(timeline).toMatch(/<TaskMarkdown source=\{taskProse\(/u);
    expect(timeline).toMatch(/<TaskMarkdown source=\{acceptanceCriteria\(/u);
  });
});
