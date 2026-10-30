// llmlint: ignore-file[code_lands_in_the_domain_that_owns_it] this repository keeps every read-API record's parser in `@onepipeline-ui/dag-model` and every route call in `@onepipeline-ui/telemetry-client` — the runs, channel, host, agents and subscription records live here the same way, and `docs/dag-ui.md` holds the app to declaring no schema or API path of its own — and the plan names these two packages as the ones this change touches. A human-item package of its own would be the only API domain split out of that layout. The generator sits beside the schema it renders and the types it writes.
/**
 * The generator of `human-items.generated.ts`: TypeScript types read off the
 * engine's exported human-item schemas (`human-items.schema.json`, which
 * `tests/contract.rs` holds to the linked engine's `human_items::schemas()`).
 *
 * It renders exactly the JSON-schema constructs that export uses — `type`,
 * `const`, `enum`, `$ref`, `oneOf`/`anyOf`, objects and arrays — and refuses any
 * other, so an engine that starts exporting a construct this does not read fails
 * the drift test rather than generating a type that silently says less.
 * Conditional constraints (`allOf` of `if`/`then`) are validation the engine's
 * decoder performs, not shape, and are not rendered.
 *
 * `human-items-codegen.test.ts` renders the checked-in schema, formats it with this
 * repository's own Biome, and compares it with the committed file;
 * `UPDATE_HUMAN_ITEM_TYPES=1` rewrites the file instead.
 */

type Schema = { readonly [key: string]: unknown };

const HEADER = `// llmlint: ignore-file[code_lands_in_the_domain_that_owns_it] generated beside human-items.ts, whose directive gives the reason: every read-API record of this repository is declared in this package.
// Generated from human-items.schema.json by human-items-codegen.ts — do not edit.
// Regenerate: UPDATE_HUMAN_ITEM_TYPES=1 npx vitest run --root packages/dag-model human-items
`;

/** Keywords that describe a value without changing its shape. */
const ANNOTATIONS = new Set([
  "description",
  "title",
  "$schema",
  "format",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "minItems",
  "allOf",
  "$defs",
]);

const RENDERED = new Set([
  "type",
  "const",
  "enum",
  "$ref",
  "oneOf",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
]);

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  )
    return JSON.stringify(value);
  throw new Error(`a literal the generator cannot render: ${String(value)}`);
}

function primitive(type: string, schema: Schema, at: string): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `readonly (${render(schema.items, `${at}.items`)})[]`;
    case "object":
      return object(schema, at);
    default:
      throw new Error(`${at}: a type the generator cannot render: ${type}`);
  }
}

function object(schema: Schema, at: string): string {
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  const fields = Object.entries(properties).map(
    ([name, value]) =>
      `readonly ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${render(value, `${at}.${name}`)};`,
  );
  if (isSchema(schema.additionalProperties)) {
    if (fields.length > 0)
      throw new Error(`${at}: named properties beside a map`);
    return `{ readonly [key: string]: ${render(schema.additionalProperties, `${at}.*`)} }`;
  }
  return `{ ${fields.join(" ")} }`;
}

function render(node: unknown, at: string): string {
  if (!isSchema(node)) throw new Error(`${at}: not a schema`);
  for (const key of Object.keys(node))
    if (!ANNOTATIONS.has(key) && !RENDERED.has(key))
      throw new Error(`${at}: a keyword the generator cannot render: ${key}`);
  if (typeof node.$ref === "string") {
    const prefix = "#/$defs/";
    if (!node.$ref.startsWith(prefix))
      throw new Error(`${at}: a reference outside $defs: ${node.$ref}`);
    const name = node.$ref.slice(prefix.length);
    // A reference beside its own properties is a tagged variant of the
    // referenced record — an internally tagged enum over a struct.
    return isSchema(node.properties) ? `${name} & ${object(node, at)}` : name;
  }
  if ("const" in node) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(" | ");
  const members = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : undefined;
  if (members !== undefined)
    return members
      .map((member, index) => `(${render(member, `${at}[${index}]`)})`)
      .join(" | ");
  if (Array.isArray(node.type))
    return node.type
      .map((type) => primitive(String(type), node, at))
      .join(" | ");
  if (typeof node.type === "string") return primitive(node.type, node, at);
  throw new Error(`${at}: a schema with no shape`);
}

/** The generated module for `exported`, unformatted. */
export function renderHumanItemTypes(exported: Schema): string {
  const definitions = new Map<string, string>();
  const roots: string[] = [];
  for (const [name, schema] of Object.entries(exported)) {
    if (name === "priority_labels") continue;
    if (!isSchema(schema)) throw new Error(`${name}: not a schema`);
    const defs = isSchema(schema.$defs) ? schema.$defs : {};
    for (const [def, value] of Object.entries(defs)) {
      const rendered = render(value, `${name}.$defs.${def}`);
      const held = definitions.get(def);
      if (held !== undefined && held !== rendered)
        throw new Error(`$defs.${def} differs between roots`);
      definitions.set(def, rendered);
    }
    roots.push(`export type ${name} = ${render(schema, name)};`);
  }
  const labels = exported.priority_labels;
  if (!isSchema(labels)) throw new Error("priority_labels: not a map");
  const item = exported.HumanItem;
  const priority =
    isSchema(item) && isSchema(item.properties)
      ? item.properties.priority
      : undefined;
  if (!isSchema(priority) || !Array.isArray(priority.enum))
    throw new Error("HumanItem.priority: not an enum");
  const order = priority.enum.map(String);
  for (const wire of order)
    if (typeof labels[wire] !== "string")
      throw new Error(`priority_labels: no label for ${wire}`);
  const defs = [...definitions]
    .filter(([name]) => !Object.hasOwn(exported, name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rendered]) => `export type ${name} = ${rendered};`);
  return [
    HEADER,
    ...roots,
    ...defs,
    "/** The wire priorities, most urgent first: the engine's declared order. */",
    `export const HUMAN_ITEM_PRIORITIES = ${JSON.stringify(order)} as const;`,
    "/** The display label of each wire priority, as the CLI prints it. */",
    `export const HUMAN_ITEM_PRIORITY_LABELS: { readonly [P in HumanItem["priority"]]: string } = ${JSON.stringify(
      Object.fromEntries(order.map((wire) => [wire, labels[wire]])),
    )};`,
    "",
  ].join("\n");
}
