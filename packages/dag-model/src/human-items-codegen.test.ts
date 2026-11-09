import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
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
 * What `source` declares, with what only its layout says taken out: a quoted
 * key that could be bare, a parenthesis around a type, and where lines break.
 * Biome's `format-check` holds the checked-in file's layout; this holds what it
 * says, without a formatter process on every run.
 */
function declared(source: string): string {
  const file = ts.createSourceFile(
    "types.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const header = source.slice(0, source.indexOf("export "));
  const visit = (node: ts.Node): string => {
    if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
    if (ts.isStringLiteral(node)) {
      const key =
        (ts.isPropertySignature(node.parent) ||
          ts.isPropertyAssignment(node.parent)) &&
        node.parent.name === node;
      return key && /^[A-Za-z_$][\w$]*$/.test(node.text)
        ? node.text
        : JSON.stringify(node.text);
    }
    if (ts.isNumericLiteral(node)) return node.text;
    const children: string[] = [];
    ts.forEachChild(node, (child) => {
      children.push(visit(child));
    });
    return `${ts.SyntaxKind[node.kind]}(${children.join(",")})`;
  };
  return `${header}${visit(file)}`;
}

describe("the generated human-item types", () => {
  it("are what the checked-in engine schema renders", () => {
    const schema: unknown = JSON.parse(
      readFileSync(join(here, "human-items.schema.json"), "utf8"),
    );
    if (typeof schema !== "object" || schema === null)
      throw new Error("the schema is not an object");
    const rendered = renderHumanItemTypes(schema as Record<string, unknown>);
    if (process.env.UPDATE_HUMAN_ITEM_TYPES)
      writeFileSync(generated, formatted(rendered));
    expect(declared(readFileSync(generated, "utf8"))).toBe(declared(rendered));
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
