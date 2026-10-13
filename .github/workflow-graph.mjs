import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { truthy } from "@actions/expressions/result";
import { parse } from "yaml";

function expressionData(value) {
  if (value === null || value === undefined) return new data.Null();
  if (typeof value === "boolean") return new data.BooleanData(value);
  if (typeof value === "number") return new data.NumberData(value);
  if (typeof value === "string") return new data.StringData(value);
  if (Array.isArray(value)) return new data.Array(...value.map(expressionData));
  return new data.Dictionary(
    ...Object.entries(value).map(([key, value]) => ({
      key,
      value: expressionData(value),
    })),
  );
}
export function evaluate(source, context) {
  source = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const statuses = new Map(
    ["always", "success", "failure", "cancelled"].map((name) => [
      name,
      {
        name,
        minArgs: 0,
        maxArgs: 0,
        call: () =>
          new data.BooleanData(
            name === "always" ||
              (name === "success" &&
                !Object.values(context.needs ?? {}).some(
                  (n) => n.result !== "success",
                )) ||
              (name === "failure" &&
                Object.values(context.needs ?? {}).some(
                  (n) => n.result === "failure",
                )) ||
              (name === "cancelled" &&
                Object.values(context.needs ?? {}).some(
                  (n) => n.result === "cancelled",
                )),
          ),
      },
    ]),
  );
  const ast = new Parser(new Lexer(source).lex().tokens, Object.keys(context), [
    ...statuses.values(),
  ]).parse();
  return new Evaluator(ast, expressionData(context), statuses).evaluate();
}
export function interpolate(value, context) {
  if (typeof value !== "string") return value;
  if (/^\$\{\{[\s\S]*\}\}$/.test(value))
    return JSON.parse(JSON.stringify(evaluate(value, context), data.replacer));
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, source) =>
    evaluate(source, context).coerceString(),
  );
}
export function expandMatrix(matrix, context) {
  if (!matrix) return [{}];
  matrix = interpolate(matrix, context);
  if (!matrix || typeof matrix !== "object")
    throw new Error("unresolved matrix");
  const dimensions = Object.entries(matrix).filter(
    ([key]) => !["include", "exclude"].includes(key),
  );
  let rows = [{}];
  for (const [key, expression] of dimensions) {
    const values = interpolate(expression, context);
    if (!Array.isArray(values))
      throw new Error(`unresolved matrix dimension ${key}`);
    rows = rows.flatMap((row) =>
      values.map((value) => ({ ...row, [key]: value })),
    );
  }
  const exclude = interpolate(matrix.exclude, context) ?? [];
  rows = rows.filter(
    (row) =>
      !exclude.some((ex) =>
        Object.entries(ex).every(([key, value]) => row[key] === value),
      ),
  );
  const original = structuredClone(rows);
  const includes = interpolate(matrix.include, context) ?? [];
  if (!Array.isArray(includes)) throw new Error("unresolved matrix include");
  if (!dimensions.length) return includes.length ? includes : rows;
  for (const include of includes) {
    let merged = false;
    for (let i = 0; i < original.length; i++) {
      if (
        dimensions.every(
          ([key]) =>
            include[key] === undefined || include[key] === original[i][key],
        )
      ) {
        Object.assign(rows[i], include);
        merged = true;
      }
    }
    if (!merged) rows.push(include);
  }
  return rows;
}
let workflowCache;
export function workflows() {
  workflowCache ??= readdirSync(".github/workflows")
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => ({
      file,
      document: parse(readFileSync(`.github/workflows/${file}`, "utf8")),
    }));
  return workflowCache;
}
export function digest() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
}
function triggered(document, scenario) {
  const triggers = document.on;
  const config =
    typeof triggers === "string"
      ? triggers === scenario.event
        ? {}
        : undefined
      : Array.isArray(triggers)
        ? triggers.includes(scenario.event)
          ? {}
          : undefined
        : triggers?.[scenario.event];
  if (config === undefined) return false;
  if (config?.types && !config.types.includes(scenario.action)) return false;
  if (config?.branches && !config.branches.includes(scenario.branch))
    return false;
  if (config?.workflows && !config.workflows.includes(scenario.upstream))
    return false;
  return true;
}
let reusableCache;
let archesCache;
const reusable =
  "nickderobertis/screencomp/.github/workflows/visual-docs-reusable.yml@v0.4.8";
export function resolveWorkflow(
  file,
  document,
  scenario,
  policy,
  prefix = "",
  suppliedInputs = {},
  stack = [],
) {
  const defaults = Object.fromEntries(
    Object.entries(
      document.on?.workflow_call?.inputs ??
        (scenario.event === "workflow_dispatch"
          ? document.on?.workflow_dispatch?.inputs
          : undefined) ??
        {},
    ).map(([key, value]) => [key, value.default]),
  );
  const context = {
    github: {
      event_name: scenario.event,
      event: { action: scenario.action, pull_request: { number: 1 } },
      repository: "nickderobertis/onepipeline-ui",
      ref: scenario.ref,
      head_ref: scenario.headRef,
    },
    inputs: { ...defaults, ...suppliedInputs, ...(scenario.inputs ?? {}) },
    vars: scenario.vars ?? { PYPI_PUBLISH: "true", NPM_PUBLISH: "true" },
    needs: {},
    matrix: {},
  };
  const rows = [];
  const pending = new Set(Object.keys(document.jobs));
  while (pending.size) {
    let progressed = false;
    for (const id of pending) {
      const job = document.jobs[id];
      const needs =
        typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
      if (needs.some((n) => !context.needs[n])) continue;
      const local = {
        ...context,
        needs: Object.fromEntries(needs.map((n) => [n, context.needs[n]])),
      };
      const prerequisitesPassed = needs.every(
        (n) => context.needs[n].result === "success",
      );
      const hasStatusFunction =
        /\b(always|success|failure|cancelled)\s*\(/.test(job.if ?? "");
      const allowed = job.if
        ? truthy(evaluate(job.if, local)) &&
          (hasStatusFunction || prerequisitesPassed)
        : prerequisitesPassed;
      let output = {};
      if (id === "changes")
        output = {
          crate: scenario.crate ?? "true",
          tier: scenario.headRef?.startsWith("release-plz-")
            ? "broader"
            : "affected",
          macos: String(policy.macosRequired),
        };
      if (id === "guard") {
        const names = Object.keys(job.outputs ?? {});
        if (names.length !== 1 || !["publish", "enabled"].includes(names[0]))
          throw new Error(`unresolved credential guard output: ${file}`);
        output =
          names[0] === "publish"
            ? { publish: scenario.cratePublish ?? "true" }
            : { enabled: "true" };
      }
      if (id === "arches") {
        archesCache ??= JSON.parse(
          execFileSync(
            "python3",
            [
              "-c",
              'import json,tomllib; print(json.dumps(tomllib.load(open("screencomp.toml","rb"))["capture"]["arches"]))',
            ],
            { encoding: "utf8" },
          ),
        );
        const arches = archesCache;
        output = {
          matrix: JSON.stringify({
            include: arches.map((arch) => ({
              arch,
              project: "",
              current: "shots/current",
              verify: "shots/verify",
              manifest: "",
              gallery_title: local.inputs["gallery-title"],
            })),
          }),
        };
      }
      context.needs[id] = {
        result: allowed ? (scenario.results?.[id] ?? "success") : "skipped",
        outputs: output,
      };
      pending.delete(id);
      progressed = true;
      // Resolve skipped runners as well: unresolved expressions are a contract
      // error, never an absence of cost. Dynamic skipped matrices use the output
      // their actual producer would emit on an admitted event.
      if (job.uses) {
        if (stack.includes(job.uses))
          throw new Error(`recursive reusable call: ${job.uses}`);
        let child;
        if (job.uses.startsWith("./.github/workflows/"))
          child = parse(readFileSync(job.uses, "utf8"));
        else if (job.uses === reusable) {
          const source = readFileSync(".github/fixtures/screencomp-v0.4.8.yml");
          const lock = JSON.parse(
            readFileSync(".github/fixtures/reusable-lock.json", "utf8"),
          );
          const blob = createHash("sha1")
            .update(`blob ${source.length}\0`)
            .update(source)
            .digest("hex");
          if (lock.call !== job.uses || lock.blob !== blob)
            throw new Error(
              `reusable workflow source differs from pinned blob: ${job.uses}`,
            );
          reusableCache ??= parse(source.toString());
          child = reusableCache;
        } else throw new Error(`unresolved reusable workflow: ${job.uses}`);
        const nested = resolveWorkflow(
          file,
          child,
          scenario,
          policy,
          `${prefix}${id} / `,
          job.with,
          [...stack, job.uses],
        );
        rows.push(
          ...nested.map((row) => ({
            ...row,
            requested: allowed && row.requested,
          })),
        );
        continue;
      }
      for (const matrix of expandMatrix(job.strategy?.matrix, local)) {
        const runner = interpolate(job["runs-on"], { ...local, matrix });
        if (
          typeof runner !== "string" ||
          !/^(ubuntu|windows|macos)-[\w.-]+$/.test(runner)
        )
          throw new Error(
            `unresolved runner ${file}:${id}: ${JSON.stringify(runner)}`,
          );
        const name = job.name
          ? interpolate(job.name, { ...local, matrix })
          : `${id}${
              Object.keys(matrix).length
                ? ` (${Object.values(matrix)
                    .filter((v) => v !== "")
                    .join(", ")})`
                : ""
            }`;
        rows.push({
          workflow: file,
          event: scenario.id,
          job: `${prefix}${id}`,
          name: `${prefix}${name}`,
          runner,
          target: matrix.target ?? matrix.arch ?? null,
          targets:
            job.env?.DARWIN_TARGETS?.split(/\s+/) ??
            (matrix.target ? [matrix.target] : []),
          requested: allowed,
          macos: runner.startsWith("macos-"),
        });
      }
    }
    if (!progressed)
      throw new Error(
        `unresolved job needs: ${file}: ${[...pending].join(", ")}`,
      );
  }
  return rows;
}
export function resolveScenario(scenario, policy) {
  return workflows()
    .filter(({ document }) => triggered(document, scenario))
    .flatMap(({ file, document }) =>
      resolveWorkflow(file, document, scenario, policy),
    );
}
