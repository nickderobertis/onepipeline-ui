import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SERVING_PID_NAME } from "./fixtures/facts-file";
import { FIXTURE_WORKSPACE } from "./playwright.config";

/** Whether the process `pid` is still alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the shared fixture server this run started — the pid it recorded in its own
 * workspace — and wait until it has exited. Playwright stops its web servers only
 * after this teardown, and that server writes a run's `summary.json` whenever it
 * reads the run, so a workspace removed under it can have a file land in a directory
 * the removal just emptied.
 */
async function stopServing(): Promise<void> {
  let pid: number;
  try {
    pid = Number(
      readFileSync(join(FIXTURE_WORKSPACE, SERVING_PID_NAME), "utf8").trim(),
    );
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid < 1 || !alive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  while (alive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Remove the fixture directory this run made for itself, and say which one.
 *
 * A per-run directory is what keeps two concurrent runs from rebuilding each other's
 * served fixture; without this it would also be what leaves one behind per run. The
 * line names the directory because a run that ends badly enough to skip this is a run
 * whose leftovers someone has to recognise.
 */
export default async function removeAndReportFixtureWorkspace(): Promise<void> {
  await stopServing();
  rmSync(FIXTURE_WORKSPACE, { recursive: true, force: true });
  process.stdout.write(
    `dag-ui e2e: removed fixture workspace ${FIXTURE_WORKSPACE}\n`,
  );
}
