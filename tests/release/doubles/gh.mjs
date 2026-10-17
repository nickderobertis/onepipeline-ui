#!/usr/bin/env node
// A local double of the GitHub CLI, for the release calls this repository makes:
// reading, uploading to, downloading from and editing a GitHub Release, and
// listing pull requests. Installed on PATH as `gh` by the journeys in this
// directory, so scripts/release.mjs, scripts/release-status.sh and the release
// workflows' own steps call it exactly as they call the real one.
//
// State lives under GH_DOUBLE_STATE:
//
//   releases/<tag>/assets/<file>  what the Release has attached
//   releases/<tag>/body           its notes
//   releases/<tag>/prerelease     'true' or 'false'
//   calls.log                     every invocation, one JSON argv per line
//   fail/<file>                   every upload of <file> fails until removed
//   prs                           what `gh pr list --jq ...` prints
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const state = process.env.GH_DOUBLE_STATE;
const args = process.argv.slice(2);
if (!state) {
  console.error("gh double: GH_DOUBLE_STATE is not set");
  process.exit(4);
}
appendFileSync(join(state, "calls.log"), `${JSON.stringify(args)}\n`);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const options = (name) =>
  args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));

const [noun, verb, tag] = args;
if (noun === "pr" && verb === "list") {
  const prs = join(state, "prs");
  process.stdout.write(existsSync(prs) ? readFileSync(prs, "utf8") : "");
  process.exit(0);
}
if (noun !== "release")
  fail(`gh double: '${args.join(" ")}' is not a call it answers`);

// The tag becomes a path under the state directory, so it is held to a tag's
// shape first.
if (
  !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$|^[a-z][a-z-]*$/.test(tag ?? "") ||
  tag.includes("..")
)
  fail(`HTTP 404: Not Found (no release ${tag})`);
const release = join(state, "releases", tag);
const assets = join(release, "assets");
if (!tag || !existsSync(release))
  fail("HTTP 404: Not Found (release not found)");
mkdirSync(assets, { recursive: true });

switch (verb) {
  case "view": {
    const json = option("--json");
    if (json === "assets") {
      for (const name of readdirSync(assets).sort()) console.log(name);
    } else if (json === "isPrerelease") {
      const flag = existsSync(join(release, "prerelease"))
        ? readFileSync(join(release, "prerelease"), "utf8").trim()
        : "false";
      console.log(JSON.stringify({ isPrerelease: flag === "true" }));
    } else if (json === "body") {
      process.stdout.write(
        existsSync(join(release, "body"))
          ? readFileSync(join(release, "body"), "utf8")
          : "",
      );
    } else fail(`gh double: no answer for --json ${json}`);
    break;
  }
  case "upload": {
    for (const file of args.slice(3).filter((a) => !a.startsWith("--"))) {
      const name = basename(file);
      if (existsSync(join(state, "fail", name)))
        fail(`HTTP 502: upload of ${name} failed`);
      if (existsSync(join(assets, name)) && !args.includes("--clobber"))
        fail(`HTTP 422: asset ${name} already exists`);
      copyFileSync(file, join(assets, name));
    }
    break;
  }
  case "download": {
    const dir = option("--dir") ?? ".";
    mkdirSync(dir, { recursive: true });
    const wanted = options("--pattern");
    const found = readdirSync(assets).filter((name) => wanted.includes(name));
    if (!found.length) fail("no assets match the file pattern");
    for (const name of found) {
      if (existsSync(join(dir, name)) && !args.includes("--clobber"))
        fail(`${name} already exists`);
      copyFileSync(join(assets, name), join(dir, name));
    }
    break;
  }
  case "edit": {
    const notes = option("--notes-file");
    if (notes) writeFileSync(join(release, "body"), readFileSync(notes));
    if (args.includes("--prerelease"))
      writeFileSync(join(release, "prerelease"), "true");
    if (args.includes("--prerelease=false"))
      writeFileSync(join(release, "prerelease"), "false");
    break;
  }
  default:
    fail(`gh double: 'release ${verb}' is not a call it answers`);
}
