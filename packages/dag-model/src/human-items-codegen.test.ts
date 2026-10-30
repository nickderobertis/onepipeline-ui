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

describe("the generated human-item types", () => {
  it("are what the checked-in engine schema renders", () => {
    const schema: unknown = JSON.parse(
      readFileSync(join(here, "human-items.schema.json"), "utf8"),
    );
    if (typeof schema !== "object" || schema === null)
      throw new Error("the schema is not an object");
    const rendered = formatted(
      renderHumanItemTypes(schema as Record<string, unknown>),
    );
    if (process.env.UPDATE_HUMAN_ITEM_TYPES) writeFileSync(generated, rendered);
    expect(readFileSync(generated, "utf8")).toBe(rendered);
  });

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
