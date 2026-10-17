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
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { TARGETS } from "./release.mjs";

// Native runners only: each platform job installs its own targets.
const WINDOWS = process.platform === "win32";
const portable = (path) => (WINDOWS ? path.replace(/\\/g, "/") : path);

function fault(message, action) {
  return Object.assign(new Error(message), { action });
}
function usage(message, action) {
  return Object.assign(fault(message, action), { exitCode: 2 });
}
async function main() {
  const [rootArg, target, version] = process.argv.slice(2);
  if (!rootArg || !target || !version)
    throw usage(
      "usage: verify-staged-release.mjs ROOT TARGET VERSION",
      "pass ROOT TARGET VERSION from the release workflow; ROOT must contain staged artifacts",
    );
  const allowed = Object.keys(TARGETS);
  if (!allowed.includes(target))
    throw usage(
      `unsupported staged target: ${target}`,
      `pass one of ${allowed.join(", ")}`,
    );
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
    throw usage(
      "invalid release version",
      "pass the Cargo.toml package version without the tag's v prefix",
    );
  const root = realpathSync(resolve(rootArg));
  if (!statSync(root).isDirectory())
    throw usage(
      "staged ROOT is not a directory",
      "pass the output directory produced by release-package.py",
    );
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "staged-release-",
    ),
  );
  const facts = TARGETS[target];
  const exe = `onepipeline-api${facts.exe}`;
  const run = (cmd, args, options = {}) =>
    execFileSync(cmd, args, {
      stdio: "pipe",
      env: { ...process.env, TMPDIR: scratch },
      shell: WINDOWS && cmd === "npm",
      ...options,
    });
  async function smoke(command) {
    run("bash", [
      "scripts/smoke-published.sh",
      "--expect-version",
      version,
      "--command",
      portable(command),
      "--label",
      `staged ${target}`,
    ]);
    const runs = join(scratch, "runs");
    mkdirSync(runs, { recursive: true });
    const server = spawn(
      command,
      ["serve", "--ui", "--runs-root", runs, "--bind", "127.0.0.1:0"],
      { shell: WINDOWS && command.endsWith(".cmd") },
    );
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
          throw fault(
            `staged server exited: ${log}`,
            "inspect the startup log and rebuild the bundled-ui binary for this target",
          );
        await setTimeout(100);
      }
      if (!address)
        throw fault(
          `staged server never bound: ${log}`,
          "inspect the startup log and confirm this host permits loopback binds",
        );
      const health = await fetch(`http://${address}/healthz`);
      if (!health.ok || (await health.json()).status !== "ok")
        throw fault(
          "staged server health failed",
          "inspect the staged server log and rebuild the bundled-ui binary from this tag",
        );
      const response = await fetch(`http://${address}/`);
      const html = await response.text();
      if (
        !response.ok ||
        html !== readFileSync("apps/dag-ui/dist/index.html", "utf8")
      )
        throw fault(
          "embedded browser view differs from built bundle",
          "build the frontend before maturin compiles with bundled-ui, then regenerate all carriers",
        );
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
          throw fault(
            `embedded asset differs: ${asset}`,
            "rebuild the frontend before compiling bundled-ui and regenerate the target carriers",
          );
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
      `onepipeline-api-v${version}-${target}.${facts.archive}`,
    );
    // The checksum first: nothing is extracted from an archive it does not
    // describe.
    const recorded = readFileSync(
      join(root, "assets", `onepipeline-api-v${version}-${target}.sha256`),
      "utf8",
    ).split(/\s+\*?/);
    if (
      recorded[0] !==
        createHash("sha256").update(readFileSync(archive)).digest("hex") ||
      recorded[1] !== `onepipeline-api-v${version}-${target}.${facts.archive}`
    )
      throw fault(
        "the staged checksum does not describe the staged archive",
        "regenerate both from one release-package.py run",
      );
    const dl = join(scratch, "archive");
    mkdirSync(dl);
    // Windows' own tar is bsdtar, which reads the .zip; Git's GNU tar does not.
    const tar = WINDOWS
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
    run(tar, ["-xf", archive, "-C", dl]);
    await smoke(join(dl, exe));
    const wheelArch = { linux: "x86_64", macos: "arm64", windows: "amd64" }[
      facts.platform
    ];
    const wheel = readdirSync(join(root, "wheels")).find(
      (name) => name.endsWith(".whl") && name.includes(wheelArch),
    );
    if (!wheel)
      throw fault(
        `missing staged wheel for ${target}`,
        "run release-package.py for this target and check its wheel platform tag",
      );
    const venv = join(scratch, "venv");
    const bin = join(venv, WINDOWS ? "Scripts" : "bin");
    run(WINDOWS ? "python" : "python3", ["-m", "venv", venv]);
    run(join(bin, "pip"), [
      "install",
      "--disable-pip-version-check",
      "--no-index",
      join(root, "wheels", wheel),
    ]);
    if (
      !readFileSync(join(bin, exe)).equals(
        readFileSync(join(root, target, exe)),
      )
    )
      throw fault(
        "pip installed different binary bytes",
        "inspect the staged wheel and recreate the venv; it must install the final wheel binary unchanged",
      );
    await smoke(join(bin, exe));
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
    const launcherPack = JSON.parse(
      run("npm", ["pack", "--json", "--pack-destination", scratch], {
        cwd: launcher,
      }).toString(),
    );
    const launcherTarball = `onepipeline-api-cli-${version}.tgz`;
    if (
      !Array.isArray(launcherPack) ||
      launcherPack.length !== 1 ||
      launcherPack[0]?.name !== "onepipeline-api-cli" ||
      launcherPack[0]?.version !== version ||
      launcherPack[0]?.filename !== launcherTarball
    )
      throw fault(
        "npm pack returned invalid launcher metadata",
        "inspect npm pack --json output; rebuild the launcher for this release version",
      );
    const [platform, arch] = facts.npm.split("-");
    const packageName = `onepipeline-api-cli-${facts.npm}`;
    const tgz = readdirSync(join(root, "npm-artifacts")).find((name) =>
      name.startsWith(`${packageName}-`),
    );
    if (!tgz)
      throw fault(
        "missing npm carrier",
        "run release-package.py on the target wheel before verification",
      );
    const bytes = readFileSync(join(root, "npm-artifacts", tgz));
    const manifest = JSON.parse(
      readFileSync(join(root, "npm", packageName, "package.json"), "utf8"),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      manifest.name !== packageName ||
      manifest.version !== version ||
      !Array.isArray(manifest.os) ||
      manifest.os.length !== 1 ||
      manifest.os[0] !== platform ||
      !Array.isArray(manifest.cpu) ||
      manifest.cpu.length !== 1 ||
      manifest.cpu[0] !== arch ||
      !Array.isArray(manifest.files) ||
      !manifest.files.includes(`bin/${exe}`)
    )
      throw fault(
        "invalid staged npm platform metadata",
        "rebuild this target's platform package with npm-build.mjs; its name, version, os, cpu and binary contents must match the selected target",
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
          { env: { ...process.env, TMPDIR: scratch }, shell: WINDOWS },
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
            : reject(
                fault(
                  `staged npm install failed (${code}): ${output}`,
                  "inspect npm output, the launcher optionalDependencies and the staged os/cpu package metadata",
                ),
              ),
        );
      });
      if (!servedCarrier)
        throw fault(
          "npm did not fetch the staged carrier",
          "inspect npm optional-dependency resolution and the staged package os/cpu metadata",
        );
    } finally {
      await new Promise((resolve) => registry.close(resolve));
    }
    const installed = join(npmRoot, "node_modules", packageName, "bin", exe);
    if (!readFileSync(installed).equals(readFileSync(join(root, target, exe))))
      throw fault(
        "npm installed different binary bytes",
        "inspect the platform package and launcher resolution; regenerate npm from the final wheel binary",
      );
    await smoke(
      join(
        npmRoot,
        "node_modules",
        ".bin",
        WINDOWS ? "onepipeline-api.cmd" : "onepipeline-api",
      ),
    );
    console.log(
      `${target}: staged archive/wheel/npm install, server and embedded view passed`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
try {
  await main();
} catch (error) {
  console.error(`verify-staged-release: ${error.message}`);
  if (error.stderr) process.stderr.write(error.stderr);
  console.error(
    `ACTION: ${error.action || "inspect the failed installer command, confirm ROOT contains this target's staged artifacts, and rebuild the bundled-ui distributions from this tag"}`,
  );
  process.exitCode = error.exitCode || 1;
}
