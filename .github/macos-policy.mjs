#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
function semantic(path, text) {
  if (path.endsWith(".json")) return JSON.parse(text);
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))",
      ],
      { input: text, encoding: "utf8" },
    ),
  );
}
function removeVersion(record) {
  if (
    !record ||
    typeof record.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      record.version,
    )
  )
    throw new Error("manifest has no readable semantic version");
  delete record.version;
}
function withoutVersion(path, text) {
  const value = semantic(path, text);
  if (path === "Cargo.toml") removeVersion(value.package);
  else if (path === "Cargo.lock") {
    const own = value.package.filter(
      (pkg) => pkg.name === "onepipeline-ui" && !pkg.source,
    );
    if (own.length !== 1)
      throw new Error("lockfile has no unique root package");
    removeVersion(own[0]);
  } else if (path.endsWith("/package.json") || path === "package.json")
    removeVersion(value);
  else throw new Error(`unsupported version file: ${path}`);
  return value;
}
function releasePrefix() {
  const config = semantic(
    "release-plz.toml",
    readFileSync(
      resolve(
        fileURLToPath(new URL("..", import.meta.url)),
        "release-plz.toml",
      ),
      "utf8",
    ),
  );
  const prefix = config.workspace?.pr_branch_prefix ?? "release-plz-";
  if (typeof prefix !== "string" || !prefix)
    throw new Error("unreadable release-plz branch prefix");
  return prefix;
}

export function classify(event, base, head) {
  // Event kind comes from the runner, so an unreadable PR payload cannot turn a
  // PR into a non-PR. Offline callers can carry the same event_name in fixtures.
  const kind =
    process.env.GITHUB_EVENT_NAME ||
    (typeof event?.event_name === "string" && event.event_name
      ? event.event_name
      : "pull_request");
  if (kind !== "pull_request")
    return {
      isReleaseOnly: false,
      macosRequired: false,
      reason: `non-PR event: ${kind}`,
    };
  const required = (reason) => ({
    isReleaseOnly: false,
    macosRequired: true,
    reason,
  });
  try {
    const pr = event.pull_request;
    if (
      !pr ||
      !event.repository?.full_name ||
      pr.head.repo.full_name !== event.repository.full_name ||
      !pr.head.ref.startsWith(releasePrefix())
    )
      return required("ordinary or untrusted PR branch");
    base = git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${base}^{commit}`,
    ).trim();
    head = git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${head}^{commit}`,
    ).trim();
    const paths = git("diff", "--name-only", "--no-renames", base, head, "--")
      .trim()
      .split("\n")
      .filter(Boolean);
    if (!paths.length) return required("empty diff does not prove a release");
    for (const path of paths) {
      if (path === "CHANGELOG.md") {
        git("show", `${base}:${path}`);
        git("show", `${head}:${path}`);
        continue;
      }
      if (
        ![
          "Cargo.toml",
          "Cargo.lock",
          "package.json",
          "npm/onepipeline-api-cli/package.json",
          "npm/onepipeline-ui/package.json",
        ].includes(path)
      )
        return required(`non-release file: ${path}`);
      const before = git("show", `${base}:${path}`);
      const after = git("show", `${head}:${path}`);
      if (
        !isDeepStrictEqual(
          withoutVersion(path, before),
          withoutVersion(path, after),
        )
      )
        return required(`non-version content: ${path}`);
    }
    return {
      isReleaseOnly: true,
      macosRequired: false,
      reason:
        "same-repository release-plz branch with semantic version/changelog-only diff",
    };
  } catch (error) {
    return required(`classification unreadable: ${error.message}`);
  }
}
if (process.argv[1]?.endsWith("macos-policy.mjs")) {
  const { values, positionals } = parseArgs({
    options: {
      event: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
    },
    allowPositionals: true,
  });
  if (positionals[0] !== "classify")
    throw new Error(
      "usage: macos-policy.mjs classify --event JSON --base REF --head REF",
    );
  let event;
  try {
    event = JSON.parse(readFileSync(values.event, "utf8"));
  } catch {
    event = null;
  }
  console.log(JSON.stringify(classify(event, values.base, values.head)));
}
