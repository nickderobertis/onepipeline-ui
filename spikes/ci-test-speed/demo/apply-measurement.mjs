// The measurement-only changes a demonstration commit carries, applied to the
// checkout in the current directory: `node <this> [--touch-src]`. The same
// edits, byte for byte, go on every side of a comparison.
//
//   - every Actions-cache and Nx remote-cache write is off: the Nx sidecar is
//     read-only, setup-bun and setup-uv save nothing, and every rust-cache step
//     keeps `save-if: false` (asserted, never changed);
//   - `lint` and `budgets` do not run: neither is measured, and both would
//     spend a judged lint or write a comment for nothing;
//   - each test job starts the spike's recorder before Bootstrap, stops it after
//     its gate step and uploads it as `spike-profile-<job>`, and asks nextest
//     for every passing test's duration (NEXTEST_STATUS_LEVEL=pass).
//
// `--touch-src` also appends a comment line to src/lib.rs, so Nx selects what a
// pull request editing the crate's Rust source selects.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const file = ".github/workflows/ci.yml";
let text = readFileSync(file, "utf8");
const fail = (why) => {
  console.error(`apply-measurement: ${why}`);
  process.exit(1);
};
function replaceAll(pattern, replacement, expected) {
  const found = text.match(pattern)?.length ?? 0;
  if (found !== expected)
    fail(`expected ${expected} matches of ${pattern}, found ${found}`);
  text = text.replace(pattern, replacement);
}
for (const m of text.matchAll(/save-if: (.*)/g))
  if (m[1].trim() !== "false") fail(`a rust-cache step saves: ${m[0]}`);

replaceAll(/CACHE_READ_ONLY: \$\{\{[^\n]*\}\}/g, "CACHE_READ_ONLY: '1'", 4);
replaceAll(/no-cache: \$\{\{[^\n]*\}\}/g, "no-cache: true", 5);
replaceAll(/enable-cache: \$\{\{[^\n]*\}\}/g, "enable-cache: false", 2);
replaceAll(
  /\n {2}lint:\n {4}if: github\.event_name == 'pull_request'\n/g,
  "\n  lint:\n    if: false\n",
  1,
);
replaceAll(
  /\n {2}budgets:\n {4}needs: \[lint, test-linux, test-windows, test-macos\]\n {4}if: always\(\)\n/g,
  "\n  budgets:\n    needs: [lint, test-linux, test-windows, test-macos]\n    if: false\n",
  1,
);
replaceAll(
  /\n {6}NX_HEAD: \*nx-head\n/g,
  "\n      NX_HEAD: *nx-head\n      NEXTEST_STATUS_LEVEL: pass\n",
  3,
);
const start = `      - name: Spike recorder — start
        run: bash spikes/ci-test-speed/recorder/record.sh start "$RUNNER_TEMP/spike-profile"
      - name: Bootstrap
`;
replaceAll(/ {6}- name: Bootstrap\n/g, start, 3);
const stop = (step) => `${step}
      - name: Spike recorder — stop
        if: always()
        run: bash spikes/ci-test-speed/recorder/record.sh stop "$RUNNER_TEMP/spike-profile"
      - name: Spike recorder — upload
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: spike-profile-\${{ github.job }}
          path: \${{ runner.temp }}/spike-profile
          retention-days: 7
`;
for (const recipe of ["ci-test-linux", "ci-test-windows", "ci-test-macos"]) {
  const pattern = new RegExp(`\\n {8}run: just ${recipe}[^\\n]*\\n`, "g");
  replaceAll(pattern, (m) => stop(m.replace(/\n$/, "")), 1);
}
writeFileSync(file, text);
if (process.argv.includes("--touch-src"))
  appendFileSync(
    "src/lib.rs",
    "// Spike measurement: a pull request editing the crate source.\n",
  );
console.log("apply-measurement: applied");
