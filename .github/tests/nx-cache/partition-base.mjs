import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function partitionBase(cwd = process.cwd(), env = process.env) {
  // Actions checks out a synthetic merge. Compare the branch's tiers to its
  // own fork point, so later changes on main cannot change the reference set.
  const head =
    env.GITHUB_EVENT_NAME === "pull_request"
      ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request
          .head.sha
      : "HEAD";
  if (head !== "HEAD" && !/^[a-f0-9]{40}$/.test(head))
    throw new Error("Invalid pull request head SHA");
  return execFileSync("git", ["merge-base", head, "origin/main"], {
    cwd,
    encoding: "utf8",
  }).trim();
}
