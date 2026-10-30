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
 * impact counts) are not JSON Schema shape on either side; they are held by a
 * verdict corpus both sides judge — the engine in `tests/contract.rs`, the
 * parsers below.
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
        // Closed or open: whether a field the record does not declare is
        // refused, which both sides have to agree on.
        closed: node.additionalProperties === false,
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

  const corpus = z
    .object({
      cases: z.array(
        z.object({
          name: z.string(),
          type: z.enum(["HumanItemDetail", "HumanItemView"]),
          accept: z.boolean(),
          record: z.unknown(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          join(
            import.meta.dirname,
            "../../../tests/fixtures/human-items/verdicts.json",
          ),
          "utf8",
        ),
      ),
    );
  const parsers = {
    HumanItemDetail: humanItemDetailSchema,
    HumanItemView: humanItemViewSchema,
  } as const;

  // The corpus `tests/contract.rs` holds the engine's decoders to: every
  // record judged here as the engine judges it, which is the drift gate on the
  // cross-field rules no JSON Schema states.
  it.each(corpus.cases)("judge $name as the engine does", (verdict) => {
    expect(parsers[verdict.type].safeParse(verdict.record).success).toBe(
      verdict.accept,
    );
  });
});
