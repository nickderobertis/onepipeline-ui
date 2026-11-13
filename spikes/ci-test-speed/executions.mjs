// An `nx-cache-entries-<job>` executions document lists every Nx task the job's
// telemetry hook saw — including the nested Nx runs a test suite starts in its
// fixture workspaces, which share the job's environment and so report into it
// (#711's coverage-units suite adds about 60 per tier). The job's own task is
// the longest record of each task id.
export function outer(tasks) {
  const best = new Map();
  for (const t of tasks) {
    const d = Date.parse(t.finished_at) - Date.parse(t.started_at);
    const cur = best.get(t.task);
    if (!cur || d > cur.d) best.set(t.task, { t, d });
  }
  return [...best.values()].map((x) => x.t);
}
