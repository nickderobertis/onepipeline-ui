import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(".github/macos-policy.mjs");
export function history() {
  const root = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "macos-history-",
    ),
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "onepipeline-ui"\nversion = "1.0.0"\n[dependencies]\nengine = "1"\n',
  );
  writeFileSync(
    join(root, "Cargo.lock"),
    'version = 4\n[[package]]\nname = "onepipeline-ui"\nversion = "1.0.0"\n[[package]]\nname = "engine"\nversion = "1.0.0"\n',
  );
  writeFileSync(join(root, "CHANGELOG.md"), "# Changes\n");
  mkdirSync(join(root, "npm/onepipeline-api-cli"), { recursive: true });
  writeFileSync(
    join(root, "npm/onepipeline-api-cli/package.json"),
    JSON.stringify({
      name: "onepipeline-api-cli",
      version: "1.0.0",
      bin: { "onepipeline-api": "bin/api.js" },
    }),
  );
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const heads = {};
  for (const kind of [
    "version-only",
    "dependency",
    "source",
    "lock-version",
    "lock-dependency",
    "json-version",
    "json-content",
  ]) {
    git("checkout", "-q", base);
    if (kind === "version-only") {
      writeFileSync(
        join(root, "Cargo.toml"),
        '[package]\nname = "onepipeline-ui"\nversion = "1.1.0"\n[dependencies]\nengine = "1"\n',
      );
      writeFileSync(join(root, "CHANGELOG.md"), "# Changes\nNew release\n");
    } else if (kind === "dependency")
      writeFileSync(
        join(root, "Cargo.toml"),
        '[package]\nname = "onepipeline-ui"\nversion = "1.1.0"\n[dependencies]\nengine = "2"\n',
      );
    else if (kind === "lock-version" || kind === "lock-dependency") {
      writeFileSync(
        join(root, "Cargo.lock"),
        `version = 4\n[[package]]\nname = "onepipeline-ui"\nversion = "${kind === "lock-version" ? "1.1.0" : "1.0.0"}"\n[[package]]\nname = "engine"\nversion = "${kind === "lock-dependency" ? "1.1.0" : "1.0.0"}"\n`,
      );
    } else if (kind.startsWith("json-")) {
      writeFileSync(
        join(root, "npm/onepipeline-api-cli/package.json"),
        JSON.stringify({
          name: "onepipeline-api-cli",
          version: "1.1.0",
          bin: {
            "onepipeline-api":
              kind === "json-content" ? "other.js" : "bin/api.js",
          },
        }),
      );
    } else writeFileSync(join(root, "source.rs"), "fn main() {}\n");
    git("add", ".");
    git("commit", "-qm", kind);
    heads[kind] = git("rev-parse", "HEAD");
  }
  const cache = new Map();
  const classify = (event, head, extraEnv = {}) => {
    const key = JSON.stringify([event, head, extraEnv]);
    if (cache.has(key)) return cache.get(key);
    const path = join(root, "event.json");
    writeFileSync(
      path,
      typeof event === "string" ? event : JSON.stringify(event),
    );
    const result = JSON.parse(
      execFileSync(
        "node",
        [cli, "classify", "--event", path, "--base", base, "--head", head],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, GITHUB_EVENT_NAME: "", ...extraEnv },
        },
      ),
    );
    cache.set(key, result);
    return result;
  };
  return {
    root,
    base,
    heads,
    classify,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
export const prEvent = (
  branch = "feature",
  fork = false,
  author = "nickderobertis",
) => ({
  event_name: "pull_request",
  repository: { full_name: "nickderobertis/onepipeline-ui" },
  pull_request: {
    user: { login: author },
    title: "chore: release",
    head: {
      ref: branch,
      repo: {
        full_name: fork
          ? "fork/onepipeline-ui"
          : "nickderobertis/onepipeline-ui",
      },
    },
  },
});
