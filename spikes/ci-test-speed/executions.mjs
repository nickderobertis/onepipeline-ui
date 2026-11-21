// An `nx-cache-entries-<job>` executions document lists every Nx task the job's
// telemetry hook saw — including the nested Nx runs a test suite starts in its
// fixture workspaces, which share the job's environment and so report into it
// (#711's coverage-units suite adds about 60 records per tier, under the real
// tiers' names, whether or not the job itself ran them). The job's own tasks are
// the ones its log's `ci-job: <job> runs N task(s): …` line selected, plus the
// Bootstrap step's `*:bootstrap` tasks; of several records of one of those, the
// longest. Without a selection only the longest-record rule applies, which keeps
// a nested record of a task the job never ran.
export function outer(tasks, selection = null) {
  const wanted = selection ? new Set(selection) : null;
  const best = new Map();
  for (const t of tasks) {
    if (wanted && !wanted.has(t.task) && !t.task.endsWith(":bootstrap"))
      continue;
    const d = Date.parse(t.finished_at) - Date.parse(t.started_at);
    const cur = best.get(t.task);
    if (!cur || d > cur.d) best.set(t.task, { t, d });
  }
  return [...best.values()].map((x) => x.t);
}
