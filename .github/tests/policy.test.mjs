import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

import { history, prEvent } from "./histories.mjs";

test("real git histories classify semantic releases and fail closed", () => {
  const h = history();
  try {
    assert.equal(
      h.classify(prEvent("release-plz-123"), h.heads["version-only"])
        .isReleaseOnly,
      true,
    );
    for (const event of [
      prEvent("feature", false, "github-actions[bot]"),
      prEvent("release-plz-123", true),
      prEvent("forged-release"),
      "{}",
      "{",
      null,
      { event_name: {} },
    ])
      assert.equal(
        h.classify(event, h.heads["version-only"]).macosRequired,
        true,
      );
    for (const kind of [
      "dependency",
      "source",
      "lock-dependency",
      "lock-same-name-registry",
      "json-content",
    ])
      assert.equal(
        h.classify(prEvent("release-plz-123"), h.heads[kind]).macosRequired,
        true,
      );
    for (const kind of ["lock-version", "json-version"])
      assert.equal(
        h.classify(prEvent("release-plz-123"), h.heads[kind]).isReleaseOnly,
        true,
      );
    assert.equal(
      h.classify(prEvent("release-plz-123"), "missing-ref").macosRequired,
      true,
    );
    assert.equal(
      h.classify("{", "missing", { GITHUB_EVENT_NAME: "push" }).macosRequired,
      false,
    );
  } finally {
    h.close();
  }
});
test("real carrier command accepts only successful work or authorized omissions", () => {
  const command = resolve(".github/macos-verdict.mjs");
  for (const CHANGES of ["success", "failure", "cancelled", "skipped", ""])
    for (const MACOS of ["success", "failure", "cancelled", "skipped", ""])
      for (const MACOS_REQUIRED of ["true", "false", ""]) {
        const result = spawnSync("node", [command], {
          env: {
            ...process.env,
            CHANGES,
            MACOS,
            MACOS_REQUIRED,
            CRATE: "true",
            QUALITY: "success",
          },
          encoding: "utf8",
        });
        const accepted =
          CHANGES === "success" &&
          ["true", "false"].includes(MACOS_REQUIRED) &&
          (MACOS === "success" ||
            (MACOS === "skipped" && MACOS_REQUIRED === "false"));
        assert.equal(
          result.status === 0,
          accepted,
          JSON.stringify({ CHANGES, MACOS, MACOS_REQUIRED }),
        );
        if (accepted && MACOS === "skipped")
          assert.match(result.stdout, /no Mac tests ran/);
      }
});
