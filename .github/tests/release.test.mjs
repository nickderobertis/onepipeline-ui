import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflows } from "../workflow-graph.mjs";

const release = () =>
  workflows().find((w) => w.file === "release.yml").document;
test("all release platforms retain archive, wheel and npm producers; Darwin publishes verified bytes on Linux", () => {
  const jobs = release().jobs;
  const launcher = JSON.parse(
    readFileSync("npm/onepipeline-api-cli/package.json", "utf8"),
  );
  const targets = jobs["build-npm"].strategy.matrix.include.map(
    (row) => row.target,
  );
  const darwin = jobs.darwin.env.DARWIN_TARGETS;
  for (const target of ["x86_64-apple-darwin", "aarch64-apple-darwin"]) {
    assert.ok(darwin.includes(target));
    targets.push(target);
  }
  assert.equal(
    targets.length,
    Object.keys(launcher.optionalDependencies).length,
  );
  for (const job of ["upload", "build-wheels"])
    assert.deepEqual(
      jobs[job].strategy.matrix.include.map((row) => row.target).sort(),
      targets.filter((t) => !t.includes("darwin")).sort(),
    );
  assert.ok(jobs["publish-pypi"].needs.includes("darwin"));
  assert.ok(jobs["publish-npm"].needs.includes("darwin"));
  assert.equal(jobs["upload-darwin"]["runs-on"], "ubuntu-latest");
  assert.deepEqual(jobs["upload-darwin"].needs, "darwin");
  const commands = jobs.darwin.steps.map((s) => s.run || "").join("\n");
  assert.match(commands, /just build/);
  assert.match(commands, /release-darwin.sh/);
  assert.match(commands, /CycloneDX|cargo cyclonedx/);
  for (const target of targets.filter((t) => t.includes("darwin")))
    assert.ok(
      commands.includes(`verify-staged-release.mjs darwin-dist ${target}`),
    );
  assert.match(commands, /install-rosetta/);
  const names = jobs.darwin.steps
    .filter((s) => s.uses === "actions/upload-artifact@v4")
    .map((s) => s.with.name);
  assert.deepEqual(names.sort(), [
    "darwin-assets",
    "darwin-reuse",
    "npm-darwin",
    "wheels-darwin",
  ]);
  const builder = readFileSync("scripts/release-darwin.sh", "utf8");
  assert.equal((builder.match(/maturin build/g) || []).length, 1);
  assert.doesNotMatch(builder, /cargo build/);
  assert.match(builder, /--features bundled-ui/);
});

test("Darwin artifact contracts preserve wheel bytes and reject an architecture mismatch without executing them", () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "darwin-contract-",
    ),
  );
  try {
    for (const target of release().jobs.darwin.env.DARWIN_TARGETS.split(
      /\s+/,
    )) {
      // A structural Mach-O fixture exercises the carrier boundary. It is never
      // executed; native installs remain the hosted Mac job's proof.
      const arch = target.startsWith("x86_64") ? "x86_64" : "arm64";
      const cpu = arch === "x86_64" ? 0x01000007 : 0x0100000c;
      const wheel = join(
        scratch,
        `onepipeline_api_cli-1.0.0-py3-none-macosx_11_0_${arch}.whl`,
      );
      execFileSync("python3", [
        "-c",
        `import struct,zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('onepipeline_api_cli-1.0.0.data/scripts/onepipeline-api',struct.pack('<IIIIIIII',0xfeedfacf,int(sys.argv[2]),0,2,0,0,0,0))
 z.writestr('onepipeline_api_cli-1.0.0.dist-info/METADATA','Name: onepipeline-api-cli\\nVersion: 1.0.0\\n')
 z.writestr('onepipeline_api_cli-1.0.0.dist-info/WHEEL','Wheel-Version: 1.0\\nTag: py3-none-macosx_11_0_'+sys.argv[3]+'\\n')`,
        wheel,
        String(cpu),
        arch,
      ]);
      const args = [
        "scripts/release-package.py",
        "--target",
        target,
        "--wheel",
        wheel,
        "--out",
        scratch,
        "--tag",
        "v1.0.0",
      ];
      execFileSync("python3", args, { stdio: "pipe" });
      execFileSync("python3", [
        "-c",
        `import hashlib,sys,tarfile,zipfile,pathlib
root=pathlib.Path(sys.argv[1]); target=sys.argv[2]
with zipfile.ZipFile(sys.argv[3]) as z:
 expected=z.read('onepipeline_api_cli-1.0.0.data/scripts/onepipeline-api')
archive=root/'assets'/('onepipeline-api-v1.0.0-'+target+'.tar.gz')
with tarfile.open(archive) as t:
 assert set(t.getnames()) == {'onepipeline-api','README.md','LICENSE','CHANGELOG.md'}
 assert t.extractfile('onepipeline-api').read() == expected
checksum=(root/'assets'/('onepipeline-api-v1.0.0-'+target+'.sha256')).read_text().split()[0]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == checksum
arch='x64' if target.startswith('x86_64') else 'arm64'
with tarfile.open(root/'npm-artifacts'/('onepipeline-api-cli-darwin-'+arch+'-1.0.0.tgz')) as t:
 assert t.extractfile('package/bin/onepipeline-api').read() == expected
`,
        scratch,
        target,
        wheel,
      ]);
      const record = JSON.parse(
        readFileSync(join(scratch, target, "reuse.json"), "utf8"),
      );
      assert.equal(record.target, target);
      assert.equal(record.binarySha256, record.archiveBinarySha256);
      assert.equal(record.binarySha256, record.wheelBinarySha256);
      assert.equal(record.binarySha256, record.npmBinarySha256);
      assert.ok(record.archive.includes(`${target}.tar.gz`));
      assert.ok(
        record.npm.includes(`darwin-${arch === "arm64" ? "arm64" : "x64"}`),
      );
      const other = target.startsWith("x86_64")
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin";
      const refused = spawnSync(
        "python3",
        args.map((value) => (value === target ? other : value)),
        { encoding: "utf8" },
      );
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /declared Darwin architecture/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
