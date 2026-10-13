#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const modules = [".github", ".github/tests"].flatMap((directory) =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => `${directory}/${file}`),
);
for (const file of modules)
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
if (!process.argv.includes("--syntax")) {
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/@biomejs/biome/bin/biome"),
      "check",
      "--error-on-warnings",
      ...modules,
      ".github/package.json",
      ".github/project.json",
    ],
    { stdio: "inherit" },
  );
}
