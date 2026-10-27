// The CycloneDX SBOM every npm platform package carries, on both sides of
// publication: what the real scripts/npm-build.mjs assembles and the real npm
// packer packs for each of the four release targets, from the document the
// release generates for that target's build with cargo-cyclonedx; and what a
// platform job's `upload npm`, with PyPI switched off, publishes to the npm
// double and refuses to.
//
// No binary is compiled here: each package carries a stand-in for the binary,
// because the subject is the document beside it. The manylinux rehearsal
// (./journeys.test.mjs) holds the package its real build stages to the same.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { plan, TARGETS } from "../../scripts/release.mjs";
import { PACKAGED_SBOM } from "../../scripts/sbom.mjs";
import {
  assertBinarySbom,
  githubDouble,
  platformSbom,
  ROOT,
  recipe,
  registryDoubles,
  releaseEnv,
  scratch,
  version,
} from "./support.mjs";

const VERSION = version();

let out;
// Each target's generated SBOM, by target.
const sboms = {};

before(() => {
  mkdirSync(join(ROOT, "target"), { recursive: true });
  out = mkdtempSync(join(ROOT, "target", "release-journey-sbom-"));
  for (const target of Object.keys(TARGETS))
    sboms[target] = platformSbom(out, target);
});

after(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

const npmBuild = (args) =>
  execFileSync("node", ["scripts/npm-build.mjs", "platform", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const npmBuildFails = (args) => {
  try {
    npmBuild(args);
  } catch (error) {
    return error.stderr;
  }
  assert.fail(`npm-build.mjs platform ${args.join(" ")} succeeded`);
};

// The platform package for `target`, assembled by npm-build.mjs from a stand-in
// binary and `sbom`, and packed by npm into `into`: the packed tarball's path.
function packed(target, sbom, into) {
  const work = join(into, "work");
  const binary = join(work, "onepipeline-api");
  mkdirSync(work, { recursive: true });
  writeFileSync(binary, `stand-in ${target} binary\n`);
  const pkg = npmBuild([
    "--target",
    target,
    "--binary",
    binary,
    "--sbom",
    sbom,
    "--version",
    VERSION,
    "--out",
    join(work, "npm"),
  ]);
  const artifacts = join(into, "npm-artifacts");
  mkdirSync(artifacts, { recursive: true });
  const [{ filename }] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", artifacts], {
      cwd: pkg,
      encoding: "utf8",
    }),
  );
  rmSync(work, { recursive: true, force: true });
  return join(artifacts, filename);
}

const entries = (tarball) =>
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
const member = (tarball, name) =>
  execFileSync("tar", ["-xzOf", tarball, `package/${name}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

describe("npm-build.mjs platform, packed by npm, for every release target", () => {
  for (const target of Object.keys(TARGETS))
    test(`${target}'s package carries exactly the SBOM generated for its build, under sboms/, named in its files`, () => {
      const into = join(out, `packed-${target}`);
      const tarball = packed(target, sboms[target], into);
      const artifact = plan(TARGETS[target].platform).artifacts.find(
        (a) => a.kind === "npm",
      );
      assert.equal(tarball, join(into, "npm-artifacts", artifact.file));
      assert.deepEqual(
        entries(tarball).filter((name) => name.startsWith("package/sboms/")),
        [`package/${PACKAGED_SBOM}`],
      );
      const manifest = JSON.parse(member(tarball, "package.json"));
      assert.equal(manifest.name, artifact.package);
      assert.ok(manifest.files.includes(PACKAGED_SBOM), manifest.files);
      const shipped = member(tarball, PACKAGED_SBOM);
      assert.equal(
        shipped,
        readFileSync(sboms[target], "utf8"),
        "the package ships the generated document unchanged",
      );
      assertBinarySbom(assert, shipped, `${artifact.package}'s SBOM`);
    });

  test("each target's document is resolved for that target's build", () => {
    const names = (target) =>
      new Set(
        JSON.parse(readFileSync(sboms[target], "utf8")).components.map(
          (c) => c.name,
        ),
      );
    assert.ok(names("x86_64-pc-windows-msvc").has("windows-sys"));
    assert.ok(!names("x86_64-unknown-linux-gnu").has("windows-sys"));
  });

  test("refuses to assemble a platform package without an SBOM, or with one that is not this binary's CycloneDX document, naming the package", () => {
    const binary = join(out, "stand-in");
    writeFileSync(binary, "stand-in binary\n");
    const base = [
      "--target",
      "aarch64-apple-darwin",
      "--binary",
      binary,
      "--out",
      join(out, "refused"),
    ];
    const missing = npmBuildFails(base);
    assert.match(missing, /--sbom <path> is required/);
    assert.match(missing, /ACTION: /);
    for (const [body, why] of [
      ["not json", /is not JSON/],
      ["[]", /is not a JSON object/],
      ['{"bomFormat":"SPDX"}', /has bomFormat "SPDX", not "CycloneDX"/],
      [
        '{"bomFormat":"CycloneDX","metadata":{"component":{"name":"other"}},"components":[],"dependencies":[]}',
        /does not describe onepipeline-ui/,
      ],
    ]) {
      const sbom = join(out, "bad.cdx.json");
      writeFileSync(sbom, body);
      const refused = npmBuildFails([...base, "--sbom", sbom]);
      assert.match(refused, /the SBOM for onepipeline-api-cli-darwin-arm64/);
      assert.match(refused, why);
      assert.match(refused, /ACTION: /);
    }
    assert.ok(
      !existsSync(join(out, "refused", "onepipeline-api-cli-darwin-arm64")),
      "nothing was assembled",
    );
  });
});

// build-linux's `upload npm`, with PYPI_PUBLISH off as the release runs now,
// against the npm double, over a package npm-build.mjs assembled.
describe("a platform job's upload npm, with PyPI switched off", () => {
  const TARGET = "x86_64-unknown-linux-gnu";
  const artifact = plan("linux").artifacts.find((a) => a.kind === "npm");
  let dir;
  let registries;
  let env;
  let good;

  before(async () => {
    dir = scratch("sbom-upload");
    const gh = githubDouble(dir, `v${VERSION}`);
    registries = await registryDoubles(dir);
    env = releaseEnv({
      gh,
      registries,
      home: dir,
      extra: { PYPI_PUBLISH: "false" },
    });
    good = packed(TARGET, sboms[TARGET], join(out, "upload-good"));
  });
  after(async () => {
    await registries?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // A copy of the good package with its sboms/ directory rewritten by `edit`,
  // repacked, staged under an --out of its own.
  function tampered(name, edit) {
    const staging = join(out, `upload-${name}`);
    const work = join(staging, "work");
    mkdirSync(join(staging, "npm-artifacts"), { recursive: true });
    mkdirSync(work, { recursive: true });
    execFileSync("tar", ["-xzf", good, "-C", work]);
    edit(join(work, "package"));
    execFileSync("tar", [
      "-czf",
      join(staging, "npm-artifacts", artifact.file),
      "-C",
      work,
      "package",
    ]);
    rmSync(work, { recursive: true, force: true });
    return staging;
  }

  for (const [name, edit, why] of [
    [
      "without-sbom",
      (pkg) => rmSync(join(pkg, "sboms"), { recursive: true }),
      /carries nothing under sboms\//,
    ],
    [
      "not-cyclonedx",
      (pkg) => writeFileSync(join(pkg, PACKAGED_SBOM), '{"bomFormat":"SPDX"}'),
      /carries a sboms\/onepipeline-api\.cyclonedx\.json that has bomFormat "SPDX"/,
    ],
    [
      "not-an-object",
      (pkg) => writeFileSync(join(pkg, PACKAGED_SBOM), "[]"),
      /carries a sboms\/onepipeline-api\.cyclonedx\.json that is not a JSON object/,
    ],
    [
      "second-file",
      (pkg) =>
        cpSync(join(pkg, PACKAGED_SBOM), join(pkg, "sboms", "extra.json")),
      /carries .*sboms\/extra\.json.* under sboms\/, not exactly/,
    ],
  ])
    test(`refuses a platform package ${name.replaceAll("-", " ")}, naming it, and publishes nothing`, () => {
      const staging = tampered(name, edit);
      for (const args of [
        ["upload", "npm", "--out", staging],
        ["upload", "npm", "--dry-run", "--out", staging],
      ]) {
        const run = recipe("linux", args, env);
        assert.notEqual(run.status, 0, run.output);
        assert.match(
          run.stderr,
          new RegExp(
            `release: ${artifact.package}: ${artifact.file.replaceAll(".", "\\.")} `,
          ),
        );
        assert.match(run.stderr, why);
        assert.match(run.stderr, /ACTION: rebuild it with this job's build/);
      }
      assert.deepEqual(registries.uploads(), []);
    });

  test("publishes the package with its SBOM, and an install from npm receives the document", () => {
    const staging = join(out, "upload-good");
    const run = recipe("linux", ["upload", "npm", "--out", staging], env);
    assert.equal(run.status, 0, run.output);
    assert.match(
      run.stdout,
      new RegExp(`npm published ${artifact.file.replaceAll(".", "\\.")}`),
    );
    const prefix = join(dir, "consumer");
    mkdirSync(prefix, { recursive: true });
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        `${artifact.package}@${VERSION}`,
      ],
      { env, stdio: "pipe" },
    );
    const installed = readFileSync(
      join(prefix, "node_modules", artifact.package, PACKAGED_SBOM),
      "utf8",
    );
    assert.equal(installed, readFileSync(sboms[TARGET], "utf8"));
    assertBinarySbom(assert, installed, "the installed SBOM");
  });
});
