import assert from "node:assert/strict";
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
test("release-prefix forgeries and unrecognised events route to macOS; known non-PR events stay Mac-free", () => {
  const h = history();
  try {
    for (const [name, event, head, extraEnv] of [
      [
        "fork-headed release branch",
        prEvent("release-plz-9", true),
        "version-only",
      ],
      [
        "release branch with a non-version change",
        prEvent("release-plz-9"),
        "source",
      ],
      [
        "same-named registry dependency version change",
        prEvent("release-plz-9"),
        "lock-same-name-registry",
      ],
      [
        "unrecognised event name",
        prEvent("release-plz-9"),
        "version-only",
        { GITHUB_EVENT_NAME: "merge_group" },
      ],
    ]) {
      const verdict = h.classify(event, h.heads[head], extraEnv);
      assert.equal(verdict.macosRequired, true, name);
      assert.equal(verdict.isReleaseOnly, false, name);
    }
    assert.match(
      h.classify(prEvent("release-plz-9"), h.heads["version-only"], {
        GITHUB_EVENT_NAME: "merge_group",
      }).reason,
      /unrecognised event: merge_group/,
    );
    for (const name of [
      "push",
      "release",
      "workflow_run",
      "repository_dispatch",
      "schedule",
      "workflow_dispatch",
    ]) {
      const verdict = h.classify({ event_name: name }, h.heads.source, {
        GITHUB_EVENT_NAME: name,
      });
      assert.equal(verdict.macosRequired, false, name);
      assert.equal(verdict.reason, `non-PR event: ${name}`);
    }
  } finally {
    h.close();
  }
});
