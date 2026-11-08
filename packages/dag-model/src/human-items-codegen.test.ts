import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderHumanItemTypes } from "./human-items-codegen.js";

const here = import.meta.dirname;
const root = join(here, "../../..");
const generated = join(here, "human-items.generated.ts");

/** `source`, formatted by this repository's own Biome as the file it lands in. */
function formatted(source: string): string {
  const biome = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/@biomejs/biome/bin/biome"),
      "format",
      `--stdin-file-path=${generated}`,
    ],
    { cwd: root, input: source, encoding: "utf8" },
  );
  if (biome.status !== 0) throw new Error(biome.stderr);
  return biome.stdout;
}

/**
 * The render is checked through a Biome subprocess, and the first run of a newly
 * installed native binary on a macOS host is held while the OS scans it: on a
 * test-macos runner whose every Biome task replayed from cache, that scan landed
 * on this test and outlasted Vitest's 5-second default. The allowance bounds a
 * subprocess, not a speed claim — the equality below is the whole assertion.
 */
const SUBPROCESS_TIMEOUT = { timeout: 30_000 };

describe("the generated human-item types", () => {
  it(
    "are what the checked-in engine schema renders",
    SUBPROCESS_TIMEOUT,
    () => {
      const schema: unknown = JSON.parse(
        readFileSync(join(here, "human-items.schema.json"), "utf8"),
      );
      if (typeof schema !== "object" || schema === null)
        throw new Error("the schema is not an object");
      const rendered = formatted(
        renderHumanItemTypes(schema as Record<string, unknown>),
      );
      if (process.env.UPDATE_HUMAN_ITEM_TYPES)
        writeFileSync(generated, rendered);
      expect(readFileSync(generated, "utf8")).toBe(rendered);
    },
  );

  it("refuses a construct it cannot render rather than saying less", () => {
    expect(() =>
      renderHumanItemTypes({
        priority_labels: {},
        Odd: { type: "object", patternProperties: {} },
      }),
    ).toThrow("a keyword the generator cannot render: patternProperties");
    expect(() =>
      renderHumanItemTypes({
        priority_labels: { urgent: "Critical" },
        HumanItem: {
          type: "object",
          properties: { priority: { type: "string", enum: ["urgent", "low"] } },
        },
      }),
    ).toThrow("priority_labels: no label for low");
  });
});
