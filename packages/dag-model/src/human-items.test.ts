import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  humanItemDetailSchema,
  humanItemReceiptSchema,
  humanItemViewSchema,
} from "./human-items.js";

/**
 * The drift gate between the browser's parsers and the engine's exported
 * schemas. The parsers are written in Zod, because the client validates with
 * it; their shape is read back out through Zod's own JSON Schema export and
 * held, field by field, to `human-items.schema.json` — the file
 * `tests/contract.rs` holds to the linked engine. A field added, dropped or
 * made optional, an enum alternative missing or added, or a nullability that
 * differs fails here naming where. The engine's cross-field rules (lifecycle,
 * impact counts) are not JSON Schema shape on either side; the tests below
 * prove the parsers refuse what the engine's decoder refuses.
 */

type Schema = { readonly [key: string]: unknown };
const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const engine: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "human-items.schema.json"), "utf8"),
);

/** A schema's shape with annotations and value constraints set aside. */
function shape(node: unknown, defs: Schema): unknown {
  if (!isSchema(node)) throw new Error(`not a schema: ${JSON.stringify(node)}`);
  if (typeof node.$ref === "string")
    return shape(defs[node.$ref.replace("#/$defs/", "")], defs);
  const members = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : undefined;
  if (members !== undefined) {
    const nullable = members.some(
      (member) => isSchema(member) && member.type === "null",
    );
    const rest = members
      .filter((member) => !(isSchema(member) && member.type === "null"))
      .map((member) => shape(member, defs));
    const literals = rest.every(
      (member) => isSchema(member) && Array.isArray(member.enum),
    );
    const of = literals
      ? {
          enum: rest
            .flatMap((member) =>
              isSchema(member) && Array.isArray(member.enum) ? member.enum : [],
            )
            .map(String)
            .sort(),
        }
      : rest.length === 1
        ? rest[0]
        : { union: rest.map((member) => JSON.stringify(member)).sort() };
    return nullable ? { nullable: of } : of;
  }
  if ("const" in node) return { enum: [String(node.const)] };
  if (Array.isArray(node.enum)) return { enum: node.enum.map(String).sort() };
  if (Array.isArray(node.type)) {
    const types = node.type.filter((type) => type !== "null");
    const of = shape({ ...node, type: types[0] }, defs);
    return node.type.includes("null") ? { nullable: of } : of;
  }
  switch (node.type) {
    case "object": {
      const properties = isSchema(node.properties) ? node.properties : {};
      return {
        object: Object.fromEntries(
          Object.entries(properties)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => [name, shape(value, defs)]),
        ),
        required: (Array.isArray(node.required) ? node.required : [])
          .map(String)
          .sort(),
      };
    }
    case "array":
      return { array: shape(node.items, defs) };
    case "integer":
    case "number":
      return node.minimum !== undefined && node.minimum === node.maximum
        ? { enum: [String(node.minimum)] }
        : "number";
    case "string":
    case "boolean":
      return node.type;
    default:
      throw new Error(`a schema with no shape: ${JSON.stringify(node)}`);
  }
}

function engineShape(name: string): unknown {
  if (!isSchema(engine)) throw new Error("the engine schema is not an object");
  const root = engine[name];
  if (!isSchema(root)) throw new Error(`the engine exports no ${name}`);
  return shape(root, isSchema(root.$defs) ? root.$defs : {});
}

function parserShape(parser: z.ZodType): unknown {
  return shape(z.toJSONSchema(parser, { unrepresentable: "any" }), {});
}

describe("the browser's human-item parsers", () => {
  it.each([
    ["HumanItemView", humanItemViewSchema],
    ["HumanItemDetail", humanItemDetailSchema],
    ["HumanItemReceipt", humanItemReceiptSchema],
  ] as const)("have the engine's %s shape", (name, parser) => {
    expect(parserShape(parser)).toEqual(engineShape(name));
  });

  const served = (name: string): unknown =>
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../tests/fixtures", name),
        "utf8",
      ),
    );
  const detail = humanItemDetailSchema.parse(served("human-item.json"));
  const receipt = humanItemReceiptSchema.parse(
    served("human-item-answer.json"),
  );

  it.each<[string, (record: typeof detail) => unknown]>([
    [
      "a schema version other than 1",
      (d) => ({ ...d, item: { ...d.item, schema_version: 2 } }),
    ],
    ["a blank body", (d) => ({ ...d, item: { ...d.item, body: "  " } })],
    [
      "an open item with a resolution",
      (d) => ({
        ...d,
        item: {
          ...d.item,
          resolution: {
            actor: "a",
            on_behalf_of: null,
            text: null,
            reason: null,
          },
        },
      }),
    ],
    [
      "a total the plans do not sum to",
      (d) => ({ ...d, blocked: { ...d.blocked, total: 6 } }),
    ],
    [
      "a preview that is not the first three steps",
      (d) => ({
        ...d,
        blocked: {
          ...d.blocked,
          plans: d.blocked.plans.map((plan, index) =>
            index === 0 ? { ...plan, preview: plan.preview.slice(0, 2) } : plan,
          ),
        },
      }),
    ],
    [
      "steps that are not the total",
      (d) => ({ ...d, nodes: d.nodes.slice(1) }),
    ],
    [
      "a step listed twice",
      (d) => ({ ...d, nodes: [...d.nodes.slice(0, -1), d.nodes[0]] }),
    ],
  ])("refuse %s, as the engine's decoder does", (_, mutate) => {
    expect(humanItemDetailSchema.safeParse(mutate(detail)).success).toBe(false);
  });

  it("refuse a resolution that does not match the item's kind and state", () => {
    const answered = receipt.item;
    for (const item of [
      { ...answered.item, kind: "task" },
      { ...answered.item, resolution: null },
      {
        ...answered.item,
        resolution: { ...answered.item.resolution, text: null },
      },
      { ...answered.item, approval: { board_copy: "doc", key: "k" } },
      {
        ...answered.item,
        state: "completed",
        kind: "task",
        resolution: { ...answered.item.resolution, text: "done" },
      },
    ])
      expect(
        humanItemViewSchema.safeParse({ ...answered, item }).success,
        JSON.stringify(item),
      ).toBe(false);
    expect(humanItemViewSchema.safeParse(answered).success).toBe(true);
  });

  it("refuse a non-blocking item that reports blocked work", () => {
    const resolved = receipt.item;
    expect(
      humanItemViewSchema.safeParse({
        ...resolved,
        blocked: detail.blocked,
      }).success,
    ).toBe(false);
  });
});
