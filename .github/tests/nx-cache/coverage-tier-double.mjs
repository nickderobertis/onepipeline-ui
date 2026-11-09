// Stands in for one coverage tier's instrumented tests in a scratch copy of the
// graph: it writes the tier's report from a directory the test filled, and records
// that it ran. Nx, the inputs, the outputs and the merge around it are the real ones.
import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [tier] = process.argv.slice(2);
const { COVERAGE_TIER_DOUBLE_DIR: dir, COVERAGE_TIER_DOUBLE_LOG: log } =
  process.env;
if (!/^[A-Za-z0-9_-]+$/.test(tier ?? "") || !dir || !log) {
  console.error(
    "coverage-tier-double: expected a tier name, COVERAGE_TIER_DOUBLE_DIR and COVERAGE_TIER_DOUBLE_LOG\nACTION: run this only through coverage-units.test.mjs",
  );
  process.exit(2);
}
mkdirSync("target/coverage-units", { recursive: true });
copyFileSync(join(dir, `${tier}.lcov`), `target/coverage-units/${tier}.lcov`);
appendFileSync(log, `${tier}\n`);
