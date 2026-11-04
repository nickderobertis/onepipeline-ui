import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CACHE_RPC_FIELDS, sidecarCheckout } from "./nx-cache-journey.mjs";

function problems(source) {
  const methods = new Map(
    [
      ...source.matchAll(
        /\{ name: "(\w+)", options: \{\}, I: (\w+), O: (\w+) \}/g,
      ),
    ].map((match) => [match[1], { request: match[2], response: match[3] }]),
  );
  const found = [];
  for (const [method, messages] of Object.entries(CACHE_RPC_FIELDS)) {
    if (!methods.has(method)) {
      found.push(`${method}: absent from the generated service`);
      continue;
    }
    for (const [direction, fields] of Object.entries(messages)) {
      const name = methods.get(method)[direction];
      const array = source.match(
        new RegExp(
          `super\\("github\\.actions\\.results\\.api\\.v1\\.${name}", (\\[[\\s\\S]*?\\])\\);`,
        ),
      );
      if (!array) {
        found.push(`${name}: generated message is absent`);
        continue;
      }
      // Only the descriptor array from the already-pinned GitHub client is
      // evaluated, in an isolated context. Message-type arrows are never called.
      const descriptors = runInNewContext(
        `(${array[1]})`,
        {},
        { timeout: 1000 },
      );
      const actual = new Map(
        descriptors.map((field) => [
          field.name.replace(/_([a-z])/g, (_match, character) =>
            character.toUpperCase(),
          ),
          field.kind === "scalar"
            ? { 9: "string", 8: "boolean", 3: "int64" }[field.T]
            : field.kind,
        ]),
      );
      for (const [field, type] of Object.entries(fields))
        if (actual.get(field) !== type)
          found.push(
            `${name}.${field}: expected ${type}, generated ${actual.get(field) ?? "absent"}`,
          );
    }
  }
  return found;
}

test("the HTTP double's RPC fields and types agree with the pinned real client's generated protocol", async () => {
  const source = readFileSync(
    join(await sidecarCheckout(), "start-cache-server/index.js"),
    "utf8",
  );
  assert.deepEqual(problems(source), []);
  const missingMethod = source.replace(
    '{ name: "CreateCacheEntry", options:',
    '{ name: "RemovedMethod", options:',
  );
  assert.ok(
    problems(missingMethod).some((problem) =>
      problem.includes("CreateCacheEntry: absent"),
    ),
  );
  const wrongType = source.replace(
    /(super\("github\.actions\.results\.api\.v1\.CreateCacheEntryRequest",[\s\S]*?name: "key",[\s\S]*?T: )9/,
    (_match, prefix) => `${prefix}8`,
  );
  assert.ok(
    problems(wrongType).some((problem) =>
      problem.includes(
        "CreateCacheEntryRequest.key: expected string, generated boolean",
      ),
    ),
  );
  const missingField = source.replace(
    /(super\("github\.actions\.results\.api\.v1\.CreateCacheEntryRequest",[\s\S]*?name: ")key"/,
    (_match, prefix) => `${prefix}removed_key"`,
  );
  assert.ok(
    problems(missingField).some((problem) =>
      problem.includes(
        "CreateCacheEntryRequest.key: expected string, generated absent",
      ),
    ),
  );
});
