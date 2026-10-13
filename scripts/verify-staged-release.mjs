#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
// Install staged products through real pip/npm, then exercise the installed
// server and embedded view. No registry publication is needed for this proof.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const [rootArg, target, version] = process.argv.slice(2);
if (!rootArg || !target || !version)
  throw new Error("usage: verify-staged-release.mjs ROOT TARGET VERSION");
const root = resolve(rootArg);
const scratch = mkdtempSync(
  join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "staged-release-"),
);
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    stdio: "pipe",
    env: { ...process.env, TMPDIR: scratch },
    ...options,
  });
async function smoke(command) {
  run("bash", [
    "scripts/smoke-published.sh",
    "--expect-version",
    version,
    "--command",
    command,
    "--label",
    `staged ${target}`,
  ]);
  const runs = join(scratch, "runs");
  mkdirSync(runs, { recursive: true });
  const server = spawn(command, [
    "serve",
    "--ui",
    "--runs-root",
    runs,
    "--bind",
    "127.0.0.1:0",
  ]);
  let log = "";
  server.stdout.on("data", (data) => {
    log += data;
  });
  server.stderr.on("data", (data) => {
    log += data;
  });
  const stopped = new Promise((resolve) => server.on("exit", resolve));
  try {
    let address;
    for (let i = 0; i < 100; i++) {
      address = log.match(/on http:\/\/([^\s]+)/)?.[1];
      if (address) break;
      if (server.exitCode !== null)
        throw new Error(`staged server exited: ${log}`);
      await setTimeout(100);
    }
    if (!address) throw new Error(`staged server never bound: ${log}`);
    const health = await fetch(`http://${address}/healthz`);
    if (!health.ok || (await health.json()).status !== "ok")
      throw new Error("staged server health failed");
    const response = await fetch(`http://${address}/`);
    const html = await response.text();
    if (
      !response.ok ||
      html !== readFileSync("apps/dag-ui/dist/index.html", "utf8")
    )
      throw new Error("embedded browser view differs from built bundle");
    for (const asset of [
      ...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),
    ].map((match) => match[1])) {
      const fetched = await fetch(`http://${address}${asset}`);
      if (
        !fetched.ok ||
        !Buffer.from(await fetched.arrayBuffer()).equals(
          readFileSync(`apps/dag-ui/dist${asset}`),
        )
      )
        throw new Error(`embedded asset differs: ${asset}`);
    }
  } finally {
    if (server.exitCode === null) server.kill("SIGTERM");
    await stopped;
  }
}
try {
  const archive = join(
    root,
    "assets",
    `onepipeline-api-v${version}-${target}.tar.gz`,
  );
  const dl = join(scratch, "archive");
  mkdirSync(dl);
  run("tar", ["-xzf", archive, "-C", dl]);
  run("shasum", ["-a", "256", "-c", archive.replace(".tar.gz", ".sha256")], {
    cwd: join(root, "assets"),
  });
  await smoke(join(dl, "onepipeline-api"));
  const wheel = readdirSync(join(root, "wheels")).find(
    (name) =>
      name.endsWith(".whl") &&
      name.includes(
        target.startsWith("x86_64")
          ? "x86_64"
          : target.includes("darwin")
            ? "arm64"
            : "aarch64",
      ),
  );
  if (!wheel) throw new Error(`missing staged wheel for ${target}`);
  const venv = join(scratch, "venv");
  run("python3", ["-m", "venv", venv]);
  run(join(venv, "bin", "pip"), [
    "install",
    "--no-index",
    join(root, "wheels", wheel),
  ]);
  if (
    !readFileSync(join(venv, "bin", "onepipeline-api")).equals(
      readFileSync(join(root, target, "onepipeline-api")),
    )
  )
    throw new Error("pip installed different binary bytes");
  await smoke(join(venv, "bin", "onepipeline-api"));
  const npmRoot = join(scratch, "npm");
  mkdirSync(npmRoot);
  const launcher = run("node", [
    "scripts/npm-build.mjs",
    "launcher",
    "--out",
    join(scratch, "launcher"),
  ])
    .toString()
    .trim();
  const launcherTarball = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: launcher,
    }).toString(),
  )[0].filename;
  const arch = target.startsWith("x86_64") ? "x64" : "arm64";
  const platform = target.includes("darwin") ? "darwin" : "linux";
  const packageName = `onepipeline-api-cli-${platform}-${arch}`;
  const tgz = readdirSync(join(root, "npm-artifacts")).find((name) =>
    name.startsWith(`${packageName}-`),
  );
  if (!tgz) throw new Error("missing npm carrier");
  const bytes = readFileSync(join(root, "npm-artifacts", tgz));
  const manifest = JSON.parse(
    readFileSync(join(root, "npm", packageName, "package.json"), "utf8"),
  );
  // Only registry transport is doubled: npm resolves the real launcher's
  // optional dependency and installs the producer's actual tarball.
  let registryUrl;
  let servedCarrier = false;
  const registry = createServer((request, response) => {
    const path = new URL(request.url, registryUrl).pathname;
    if (path === "/carrier.tgz") {
      servedCarrier = true;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": bytes.length,
      });
      response.end(bytes);
    } else if (path === `/${packageName}`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          name: packageName,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              ...manifest,
              dist: {
                tarball: `${registryUrl}/carrier.tgz`,
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
              },
            },
          },
        }),
      );
    } else {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: "no staged package for this platform" }),
      );
    }
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  registryUrl = `http://127.0.0.1:${registry.address().port}`;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "npm",
        [
          "install",
          "--prefix",
          npmRoot,
          "--cache",
          join(scratch, "npm-cache"),
          "--registry",
          registryUrl,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          join(scratch, launcherTarball),
        ],
        { env: { ...process.env, TMPDIR: scratch } },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`staged npm install failed (${code}): ${output}`)),
      );
    });
    if (!servedCarrier) throw new Error("npm did not fetch the staged carrier");
  } finally {
    await new Promise((resolve) => registry.close(resolve));
  }
  const installed = join(
    npmRoot,
    "node_modules",
    packageName,
    "bin",
    "onepipeline-api",
  );
  if (
    !readFileSync(installed).equals(
      readFileSync(join(root, target, "onepipeline-api")),
    )
  )
    throw new Error("npm installed different binary bytes");
  await smoke(join(npmRoot, "node_modules", ".bin", "onepipeline-api"));
  console.log(
    `${target}: staged archive/wheel/npm install, server and embedded view passed`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
