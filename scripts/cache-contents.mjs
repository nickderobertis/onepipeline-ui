#!/usr/bin/env node
// Spike harness: what one onepipeline-ui Rust cache family holds, and what each
// part costs the job that restores it if it left.
//
// One command sizes one family on one platform:
//
//   node scripts/cache-contents.mjs linux     (or windows)
//
// Off a runner that re-runs the `contents (<os>)` job of this draft's latest
// cache-contents.yml run, waits for it, and prints its CACHE-CONTENTS records.
// On a runner the workflow calls the two phases itself, because the restored
// tree has to be listed before anything compiles into it:
//
//   node scripts/cache-contents.mjs --snapshot    after rust-cache restores
//   node scripts/cache-contents.mjs --attribute   after the tools are installed
//
// Every figure is printed as `CACHE-CONTENTS <json>`, one record a line.
//
//   bucket     a directory's raw bytes and its own zstd archive bytes
//   family     the whole restored family recompressed the way actions/cache
//              saves it (tar --posix | zstd -T0, read off a warm job's save log:
//              `zstdmt` on Linux, `zstd -T0` on Windows; neither passes --long)
//   line       a compile line's first run over the restored tree, and how many
//              non-workspace units it had to rebuild
//   units      target/debug's units split by which compile lines reach them
//   marginal   the archive bytes the family loses without one part: the saving
//   stale      units in a directory no compile line read (by atime, Linux only)
//   overlap    libraries of target/llvm-cov-target's current units byte-identical
//              to target/debug's, which is what sharing one build would need
//   marginal_after_prune  as marginal, over the family with every stale unit gone
//   price      a part removed and its compile line re-run. added_seconds is that
//              less the line's base_seconds, its run over the restored family,
//              because a pull request's run compiles the workspace crates anyway
//   proof      the stale units removed and every warm line re-run
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

const REPO = "nickderobertis/onepipeline-ui";
const WORKFLOW = "cache-contents.yml";
const OSES = ["linux", "windows"];
const UNIT = /-([0-9a-f]{16})(?=\.|$)/;
const WHEEL_TARGET = "x86_64-unknown-linux-gnu";

const root = process.cwd();
const home = homedir();
const cargoHome = process.env.CARGO_HOME || join(home, ".cargo");
const temp =
  process.env.RUNNER_TEMP || process.env.ONEPIPELINE_NODE_SCRATCH_DIR || "/tmp";
const snapshotFile = join(temp, "cache-contents-snapshot.json");
const os = { linux: "linux", win32: "windows", darwin: "macos" }[
  process.platform
];

function record(kind, fields) {
  console.log(`CACHE-CONTENTS ${JSON.stringify({ kind, ...fields })}`);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

/** Every regular file below `dir`, relative to `base`, with its size. */
function walk(dir, base, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, base, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push({
        path: toPosix(relative(base, path)),
        bytes: lstatSync(path).size,
      });
    }
  }
  return out;
}

function shell(script, options = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
}

/** The archive bytes of target-relative and cargo-home-relative file lists. */
function archiveBytes(targetFiles, cargoFiles = []) {
  const present = (base, files) =>
    files.filter((file) => existsSync(join(base, file)));
  const stamp = `${process.pid}-${Date.now()}`;
  const targetList = toPosix(join(temp, `cc-target-${stamp}.list`));
  const cargoList = toPosix(join(temp, `cc-cargo-${stamp}.list`));
  writeFileSync(
    targetList,
    present(root, targetFiles)
      .map((f) => `${f}\n`)
      .join(""),
  );
  writeFileSync(
    cargoList,
    present(cargoHome, cargoFiles)
      .map((f) => `${f}\n`)
      .join(""),
  );
  const result = shell(
    `set -o pipefail; { tar --posix -cf - -T "$TARGET_LIST"; ( cd "$CARGO_ROOT" && tar --posix -cf - -T "$CARGO_LIST" ); } | zstd -T0 -c | wc -c`,
    {
      env: {
        TARGET_LIST: targetList,
        CARGO_LIST: cargoList,
        CARGO_ROOT: toPosix(cargoHome),
      },
    },
  );
  rmSync(targetList);
  rmSync(cargoList);
  if (result.status !== 0) {
    record("error", {
      what: "archiveBytes",
      stderr: result.stderr.slice(-400),
    });
    return null;
  }
  return Number(result.stdout.trim());
}

function sum(files) {
  return files.reduce((total, file) => total + file.bytes, 0);
}

/** The first three path components, the size a directory is reported at. */
function bucketOf(path, depth = 3) {
  return path.split("/").slice(0, depth).join("/");
}

function snapshot() {
  const du = shell(
    `du -k -d 3 target "$CARGO_ROOT/bin" "$CARGO_ROOT/registry" "$CARGO_ROOT/git" 2>/dev/null | sort -k1,1nr | head -60`,
    { env: { CARGO_ROOT: toPosix(cargoHome) } },
  );
  console.log(`::group::du -k -d 3 target ~/.cargo\n${du.stdout}::endgroup::`);
  const before = new Set(
    existsSync(join(temp, "cargo-bin-before"))
      ? readFileSync(join(temp, "cargo-bin-before"), "utf8").split(/\r?\n/)
      : [],
  );
  const target = walk(join(root, "target"), root);
  const cargo = [];
  for (const name of [
    "bin",
    "registry",
    "git",
    ".crates.toml",
    ".crates2.json",
  ]) {
    const path = join(cargoHome, name);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) walk(path, cargoHome, cargo);
    else cargo.push({ path: name, bytes: lstatSync(path).size });
  }
  // rust-cache drops what `~/.cargo/bin` held before it restored, so what was
  // there first is not part of the family.
  const restoredCargo = cargo.filter(
    (file) => !(file.path.startsWith("bin/") && before.has(file.path.slice(4))),
  );
  writeFileSync(snapshotFile, JSON.stringify({ target, cargo: restoredCargo }));
  const raw = sum(target) + sum(restoredCargo);
  record("family", {
    os,
    raw_bytes: raw,
    archive_bytes: archiveBytes(
      target.map((f) => f.path),
      restoredCargo.map((f) => f.path),
    ),
  });
  const buckets = new Map();
  for (const file of target) {
    const key = bucketOf(file.path);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(file);
  }
  for (const file of restoredCargo) {
    const key = `~/.cargo/${bucketOf(file.path, 2)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(file);
  }
  const ordered = [...buckets.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
  for (const [bucket, files] of ordered.slice(0, 30)) {
    const raw_bytes = sum(files);
    const onCargo = bucket.startsWith("~/");
    const list = files.map((f) => f.path);
    record("bucket", {
      bucket,
      files: files.length,
      raw_bytes,
      archive_bytes:
        raw_bytes < 1_000_000
          ? null
          : onCargo
            ? archiveBytes([], list)
            : archiveBytes(list),
    });
  }
  const extensions = new Map();
  for (const file of target) {
    if (!file.path.startsWith("target/debug/deps/")) continue;
    const ext = file.path.includes(".")
      ? file.path.slice(file.path.lastIndexOf("."))
      : "(none)";
    extensions.set(ext, (extensions.get(ext) ?? 0) + file.bytes);
  }
  record("deps_by_extension", { raw_bytes: Object.fromEntries(extensions) });
}

/** The target/debug compile lines `scripts/ci-warm.sh --plan` names, with JSON. */
function debugLines() {
  const lines = [
    {
      id: "_crate-lint",
      json: "cargo clippy --all-targets --locked --quiet --message-format=json -- -D warnings",
      price: "just _crate-lint",
    },
    {
      id: "dag-ui-build-cache:lint",
      json: "cargo clippy --locked --quiet --test build-cache --message-format=json -- -D warnings",
      price: "cargo clippy --locked --quiet --test build-cache -- -D warnings",
    },
    {
      id: "_tier-test",
      json: "cargo nextest run --locked --no-run --cargo-message-format json",
      price: "cargo nextest run --locked --no-run",
    },
  ];
  if (os === "windows") return lines;
  lines.push({
    id: "_crate-install-build",
    json: `cargo build --locked --bin onepipeline-api --target-dir target/install-smoke/target --config 'build.build-dir="target"' --message-format=json`,
    price: "just _crate-install-build",
  });
  if (os !== "linux") return lines;
  const msrv = shell(
    `sed -n 's/^rust-version *= *"\\([^"]*\\)".*/\\1/p' Cargo.toml`,
  ).stdout.trim();
  lines.push(
    {
      id: "_crate-msrv",
      json: `RUSTFLAGS="-D warnings" cargo +${msrv} check --locked --all-targets --quiet --message-format=json`,
      price: "just _crate-msrv",
    },
    {
      id: "_crate-doc",
      json: `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked --quiet --message-format=json`,
      price: "just _crate-doc",
    },
    {
      id: "nx dag-ui:build-api-server",
      json: `CARGO_BUILD_BUILD_DIR=target cargo build --locked --bin onepipeline-api --target-dir target/dag-ui-api --message-format=json`,
      price: "bash scripts/nx.sh run dag-ui:build-api-server --skip-nx-cache",
    },
    {
      id: "test tests/e2e/linked_report.rs",
      json: `cargo auditable build --offline --locked --bin onepipeline-api --config 'build.build-dir="target"' --target-dir target/auditable --message-format=json`,
      price: `cargo auditable build --offline --locked --bin onepipeline-api --config 'build.build-dir="target"' --target-dir target/auditable`,
    },
  );
  return lines;
}

const COVERED = `cargo llvm-cov nextest --locked --no-report -E 'none()' --no-tests=pass`;
const WHEEL = `just wheel-linux ${WHEEL_TARGET} .tools/wheel-smoke`;

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashesOf(message) {
  const hashes = [];
  const paths = [
    ...(message.filenames ?? []),
    ...(message.out_dir ? [message.out_dir] : []),
  ];
  for (const path of paths) {
    for (const segment of path.split(/[\\/]/)) {
      const match = UNIT.exec(segment);
      if (match) hashes.push(match[1]);
    }
  }
  return hashes;
}

function timed(script) {
  const started = Date.now();
  const result = shell(script, { stdio: ["ignore", "ignore", "inherit"] });
  return { seconds: (Date.now() - started) / 1000, status: result.status };
}

function runLine(line) {
  const started = Date.now();
  const stream = join(temp, `cc-line-${process.pid}.jsonl`);
  const fd = openSync(stream, "w");
  const result = spawnSync("bash", ["-c", line.json], {
    cwd: root,
    stdio: ["ignore", fd, "inherit"],
    env: process.env,
  });
  closeSync(fd);
  const seconds = (Date.now() - started) / 1000;
  const claims = new Set();
  let rebuilt = 0;
  let fresh = 0;
  for (const text of readFileSync(stream, "utf8").split("\n")) {
    if (!text.startsWith("{")) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      continue;
    }
    if (
      message.reason !== "compiler-artifact" &&
      message.reason !== "build-script-executed"
    ) {
      continue;
    }
    for (const hash of hashesOf(message)) claims.add(hash);
    if (message.reason === "compiler-artifact") {
      if (message.fresh) fresh += 1;
      else if (!String(message.package_id).startsWith("path+")) rebuilt += 1;
    }
  }
  rmSync(stream);
  record("line", {
    id: line.id,
    base_seconds: seconds,
    status: result.status,
    fresh_units: fresh,
    rebuilt_non_workspace_units: rebuilt,
  });
  return { ...line, claims, base_seconds: seconds };
}

function unitOf(path) {
  for (const segment of path.split("/")) {
    const match = UNIT.exec(segment);
    if (match) return match[1];
  }
  return null;
}

function unitsUnder(files, prefix) {
  const units = new Map();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const unit = unitOf(file.path.slice(prefix.length)) ?? "(no unit)";
    if (!units.has(unit)) units.set(unit, []);
    units.get(unit).push(file);
  }
  return units;
}

function crateOf(files) {
  const named = files.find((f) => /\.fingerprint\/|deps\//.test(f.path));
  if (!named) return "(unknown)";
  const tail = named.path.match(/(?:\.fingerprint|deps)\/([^/]+)/)?.[1] ?? "";
  return tail.replace(UNIT, "").replace(/^lib/, "").replace(/\..*$/, "");
}

/** Age the atimes under `dirs`, mtimes untouched, so relatime records the next read. */
function ageAtimes(dirs) {
  shell(`find ${dirs} -type f -exec touch -a -d 2001-01-01 {} +`);
}

/** Which units of a tree a command read: any file's atime newer than the aged one. */
function readUnits(files, prefix) {
  const read = new Set();
  const cutoff = new Date("2002-01-01T00:00:00Z").getTime();
  for (const [unit, unitFiles] of unitsUnder(files, prefix)) {
    for (const file of unitFiles) {
      const path = join(root, file.path);
      if (existsSync(path) && lstatSync(path).atimeMs > cutoff) {
        read.add(unit);
        break;
      }
    }
  }
  return read;
}

function report(label, units, keep) {
  const stale = [...units.entries()].filter(
    ([unit]) => !keep.has(unit) && unit !== "(no unit)",
  );
  const byCrate = new Map();
  for (const [, files] of stale) {
    const crate = crateOf(files);
    byCrate.set(crate, (byCrate.get(crate) ?? 0) + sum(files));
  }
  record("stale", {
    tree: label,
    units_total: units.size,
    units_stale: stale.length,
    raw_bytes_total: sum([...units.values()].flat()),
    raw_bytes_stale: sum(stale.flatMap(([, files]) => files)),
    top_stale_crates: [...byCrate.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15),
  });
  return stale.flatMap(([, files]) => files);
}

function remove(paths) {
  for (const path of paths)
    rmSync(join(root, path), { force: true, recursive: true });
}

function attribute() {
  const { target, cargo } = JSON.parse(readFileSync(snapshotFile, "utf8"));
  const allTarget = target.map((f) => f.path);
  const allCargo = cargo.map((f) => f.path);
  const whole = archiveBytes(allTarget, allCargo);
  record("marginal", { part: "(whole family)", archive_bytes: whole });

  const marginal = (part, removed) => {
    const gone = new Set(removed);
    const size = archiveBytes(
      allTarget.filter((p) => !gone.has(p)),
      allCargo.filter((p) => !gone.has(p)),
    );
    record("marginal", {
      part,
      files: gone.size,
      raw_bytes: sum([...target, ...cargo].filter((f) => gone.has(f.path))),
      archive_bytes_saved:
        size === null || whole === null ? null : whole - size,
    });
  };

  // Directories other than target/debug leave whole.
  const topDirs = new Map();
  for (const file of target) {
    const key = bucketOf(file.path, 2);
    if (key === "target/debug") continue;
    if (!topDirs.has(key)) topDirs.set(key, []);
    topDirs.get(key).push(file.path);
  }
  for (const [dir, paths] of topDirs) {
    if (paths.length > 10) marginal(dir, paths);
  }
  marginal(
    "~/.cargo/registry",
    allCargo.filter((p) => p.startsWith("registry/")),
  );
  marginal(
    "~/.cargo/git",
    allCargo.filter((p) => p.startsWith("git/")),
  );
  marginal(
    "~/.cargo/bin",
    allCargo.filter((p) => p.startsWith("bin/")),
  );

  const covPrefix = "target/llvm-cov-target/debug/";
  const covFiles = target.filter((f) => f.path.startsWith(covPrefix));
  const wheelFiles = target.filter((f) => f.path.startsWith("target/wheel-"));
  const atime =
    os === "linux"
      ? shell("findmnt -no OPTIONS -T target").stdout.trim()
      : null;
  record("atime", { mount_options: atime });

  const lines = debugLines().map(runLine);
  const debugPrefix = "target/debug/";
  const debugFiles = target.filter((f) => f.path.startsWith(debugPrefix));
  const debugUnits = unitsUnder(debugFiles, debugPrefix);
  const claimedBy = new Map();
  for (const [unit] of debugUnits) {
    claimedBy.set(
      unit,
      lines.filter((line) => line.claims.has(unit)).map((line) => line.id),
    );
  }
  const groups = new Map();
  for (const [unit, files] of debugUnits) {
    const ids = claimedBy.get(unit);
    const key = ids.length === 0 ? "(no line: stale)" : ids.join(" + ");
    if (!groups.has(key)) groups.set(key, { units: 0, files: [] });
    groups.get(key).units += 1;
    groups.get(key).files.push(...files);
  }
  for (const [key, group] of [...groups.entries()].sort(
    (a, b) => sum(b[1].files) - sum(a[1].files),
  )) {
    record("units", {
      reached_by: key,
      units: group.units,
      raw_bytes: sum(group.files),
    });
  }
  const keepDebug = new Set(
    [...claimedBy.entries()]
      .filter(([, ids]) => ids.length > 0)
      .map(([unit]) => unit),
  );
  const staleDebug = report("target/debug", debugUnits, keepDebug).map(
    (f) => f.path,
  );
  marginal("target/debug: units no line reaches", staleDebug);
  const exclusive = new Map(lines.map((line) => [line.id, []]));
  for (const [unit, files] of debugUnits) {
    const ids = claimedBy.get(unit);
    if (ids.length === 1)
      exclusive.get(ids[0]).push(...files.map((f) => f.path));
  }
  for (const [id, paths] of exclusive) {
    if (paths.length) marginal(`target/debug: units only ${id} reaches`, paths);
  }

  const staleOther = [];
  if (os === "linux") {
    // A line that reads a tree tells apart what it still uses by atime.
    ageAtimes("target/llvm-cov-target target/wheel-*");
    const covBase = timed(COVERED);
    record("line", {
      id: "_tier-test-covered",
      base_seconds: covBase.seconds,
      status: covBase.status,
    });
    const wheelBase = timed(WHEEL);
    record("line", {
      id: "_crate-wheel-smoke",
      base_seconds: wheelBase.seconds,
      status: wheelBase.status,
    });
    const covUnits = unitsUnder(covFiles, covPrefix);
    const covRead = readUnits(covFiles, covPrefix);
    const wheelPrefix = "target/wheel-";
    const wheelRead = readUnits(wheelFiles, wheelPrefix);
    record("atime", {
      units_read: { covered: covRead.size, wheel: wheelRead.size },
    });
    // Nothing read means atime records nothing here, not that nothing is used.
    const staleCov = covRead.size
      ? report("target/llvm-cov-target/debug", covUnits, covRead)
      : [];
    const staleWheel = wheelRead.size
      ? report("target/wheel-*", unitsUnder(wheelFiles, wheelPrefix), wheelRead)
      : [];
    marginal(
      "target/llvm-cov-target: units its line did not read",
      staleCov.map((f) => f.path),
    );
    marginal(
      "target/wheel-*: units its line did not read",
      staleWheel.map((f) => f.path),
    );
    staleOther.push(
      ...staleCov.map((f) => f.path),
      ...staleWheel.map((f) => f.path),
    );
    lines.push({
      id: "_tier-test-covered",
      price: COVERED,
      base_seconds: covBase.seconds,
    });
    lines.push({
      id: "_crate-wheel-smoke",
      price: WHEEL,
      base_seconds: wheelBase.seconds,
    });

    // Instrumented units with an uninstrumented twin could share one build. The
    // libraries alone are compared: a .d file's text names its target directory.
    const covLibs = covFiles.filter(
      (f) =>
        /\.(rlib|rmeta|so)$/.test(f.path) &&
        covRead.has(unitOf(f.path.slice(covPrefix.length))),
    );
    let same = 0;
    let sameBytes = 0;
    for (const file of covLibs) {
      const twin = join(root, debugPrefix, file.path.slice(covPrefix.length));
      if (!existsSync(twin) || lstatSync(twin).size !== file.bytes) continue;
      if (digest(twin) === digest(join(root, file.path))) {
        same += 1;
        sameBytes += file.bytes;
      }
    }
    record("overlap", {
      tree: "target/llvm-cov-target/debug",
      libraries_current: covLibs.length,
      raw_bytes_current: sum(covLibs),
      identical_to_debug: same,
      raw_bytes_identical: sameBytes,
    });
  }

  // What each part saves once the stale units are gone, the family a prune leaves.
  const staleAll = new Set([...staleDebug, ...staleOther]);
  const prunedTarget = allTarget.filter((p) => !staleAll.has(p));
  const pruned = archiveBytes(prunedTarget, allCargo);
  record("marginal", {
    part: "(family with every stale unit gone)",
    files: staleAll.size,
    raw_bytes: sum(target.filter((f) => staleAll.has(f.path))),
    archive_bytes: pruned,
    archive_bytes_saved:
      whole === null || pruned === null ? null : whole - pruned,
  });
  const afterPrune = (part, removed) => {
    const gone = new Set(removed);
    const size = archiveBytes(
      prunedTarget.filter((p) => !gone.has(p)),
      allCargo.filter((p) => !gone.has(p)),
    );
    record("marginal_after_prune", {
      part,
      raw_bytes: sum(
        [...target, ...cargo].filter(
          (f) => gone.has(f.path) && !staleAll.has(f.path),
        ),
      ),
      archive_bytes_saved:
        size === null || pruned === null ? null : pruned - size,
    });
  };
  const groupPaths = new Map();
  for (const [unit, files] of debugUnits) {
    const ids = claimedBy.get(unit);
    if (ids.length === 0) continue;
    const key = ids.join(" + ");
    if (!groupPaths.has(key)) groupPaths.set(key, []);
    groupPaths.get(key).push(...files.map((f) => f.path));
  }
  for (const [key, paths] of groupPaths)
    afterPrune(`target/debug: units reached by ${key}`, paths);
  for (const [dir, paths] of topDirs) {
    if (paths.length > 10) afterPrune(dir, paths);
  }
  afterPrune(
    "target/debug",
    debugFiles.map((f) => f.path),
  );
  afterPrune(
    "~/.cargo/registry",
    allCargo.filter((p) => p.startsWith("registry/")),
  );
  afterPrune(
    "~/.cargo/bin",
    allCargo.filter((p) => p.startsWith("bin/")),
  );

  // The stale units go for good: every warm line then has to find what it needs.
  remove([...staleDebug, ...staleOther]);
  const proof = timed(`bash scripts/ci-warm.sh ${os}`);
  record("proof", {
    removed_files: staleDebug.length + staleOther.length,
    all_warm_lines_seconds: proof.seconds,
    status: proof.status,
  });

  const price = (part, removed, script, base) => {
    remove(removed);
    const run = timed(script);
    record("price", {
      part,
      command: script,
      seconds: run.seconds,
      base_seconds: base,
      added_seconds: run.seconds - base,
      status: run.status,
    });
  };
  for (const line of lines) {
    const paths = exclusive.get(line.id) ?? [];
    if (paths.length)
      price(
        `units only ${line.id} reaches`,
        paths,
        line.price,
        line.base_seconds,
      );
  }
  const baseSum = (ids) =>
    lines
      .filter((line) => ids.includes(line.id))
      .reduce((total, line) => total + line.base_seconds, 0);
  const chain = (ids) =>
    lines
      .filter((line) => ids.includes(line.id))
      .map((line) => line.price)
      .join(" && ");
  for (const [key, paths] of groupPaths) {
    const ids = key.split(" + ");
    if (ids.length > 1)
      price(`units reached by ${key}`, paths, chain(ids), baseSum(ids));
  }
  const debugIds = debugLines().map((line) => line.id);
  price("target/debug", ["target/debug"], chain(debugIds), baseSum(debugIds));
  if (os === "linux") {
    const baseOf = (id) => lines.find((line) => line.id === id).base_seconds;
    price(
      "target/llvm-cov-target",
      ["target/llvm-cov-target"],
      COVERED,
      baseOf("_tier-test-covered"),
    );
    price(
      `target/wheel-${WHEEL_TARGET}`,
      [`target/wheel-${WHEEL_TARGET}`],
      WHEEL,
      baseOf("_crate-wheel-smoke"),
    );
  }
  if (os === "windows") {
    price(
      "target/install-smoke",
      ["target/install-smoke"],
      "just _crate-install-build",
      0,
    );
  }
}

function gh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (result.status !== 0) {
    console.error(`gh ${args.join(" ")} failed: ${result.stderr}`);
    console.error(
      "ACTION: check `gh auth status`, and that this branch's draft has a cache-contents.yml run",
    );
    process.exit(1);
  }
  return result.stdout;
}

function drive(platform) {
  const branch = spawnSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  }).stdout.trim();
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "-R",
      REPO,
      "-w",
      WORKFLOW,
      "-b",
      branch,
      "-L",
      "1",
      "--json",
      "databaseId",
    ]),
  );
  if (runs.length === 0) {
    console.error(`no ${WORKFLOW} run on ${branch}`);
    console.error(
      `ACTION: publish this branch as a draft; the draft's push is ${WORKFLOW}'s only trigger`,
    );
    process.exit(1);
  }
  const run = String(runs[0].databaseId);
  const jobName = `contents (${platform})`;
  const jobs = JSON.parse(
    gh(["run", "view", run, "-R", REPO, "--json", "jobs"]),
  ).jobs;
  const job = jobs.find((candidate) => candidate.name === jobName);
  if (!job) {
    console.error(`run ${run} has no job '${jobName}'`);
    console.error(
      `ACTION: add ${platform} to ${WORKFLOW}'s matrix and push the draft`,
    );
    process.exit(1);
  }
  gh(["run", "rerun", run, "-R", REPO, "--job", String(job.databaseId)]);
  spawnSync(
    "gh",
    ["run", "watch", run, "-R", REPO, "--interval", "60", "--exit-status"],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const fresh = JSON.parse(
    gh(["run", "view", run, "-R", REPO, "--json", "jobs"]),
  ).jobs.find((candidate) => candidate.name === jobName);
  const log = gh([
    "api",
    "--allow-escape-sequences",
    `repos/${REPO}/actions/jobs/${fresh.databaseId}/logs`,
  ]);
  for (const text of log.split("\n")) {
    const at = text.indexOf("CACHE-CONTENTS {");
    if (at >= 0) console.log(text.slice(at));
  }
  console.log(`run ${run}, job ${fresh.databaseId}, ${fresh.conclusion}`);
  process.exit(fresh.conclusion === "success" ? 0 : 1);
}

const [argument] = process.argv.slice(2);
if (argument === "--snapshot") snapshot();
else if (argument === "--attribute") attribute();
else if (OSES.includes(argument)) drive(argument);
else {
  console.error(
    `usage: cache-contents.mjs ${OSES.join("|")} | --snapshot | --attribute; got '${argument ?? ""}'`,
  );
  console.error("ACTION: name the platform whose family to size");
  process.exit(2);
}
