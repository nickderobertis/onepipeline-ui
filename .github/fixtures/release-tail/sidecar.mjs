// What a release-tail recording's sidecar may say, read the same way by the
// replay double that serves it and by reconcile.mjs that holds it to GitHub.

// The one change a recording may be served with: `null`, or a reason and the
// fields to rewrite on named jobs of a jobs listing, each a set of field values.
export function servedWithChange(sidecar, file) {
  const change = sidecar?.served_with;
  if (change === null || change === undefined) return null;
  const jobs = change?.jobs;
  const valid =
    typeof change === "object" &&
    typeof change.reason === "string" &&
    change.reason.length > 0 &&
    jobs &&
    typeof jobs === "object" &&
    !Array.isArray(jobs) &&
    Object.keys(jobs).length > 0 &&
    Object.entries(jobs).every(
      ([id, fields]) =>
        /^\d+$/.test(id) &&
        fields &&
        typeof fields === "object" &&
        !Array.isArray(fields) &&
        Object.keys(fields).length > 0,
    );
  if (!valid)
    throw new Error(
      `the sidecar ${file} has a served_with that is not {reason, jobs: {<job id>: {<field>: <value>}}}`,
    );
  return change;
}

// Where a recording came from: the repository and the release it was read for.
export function fetchedFrom(text) {
  let source;
  try {
    source = JSON.parse(text ?? "");
  } catch {
    source = undefined;
  }
  if (
    !source ||
    typeof source !== "object" ||
    !/^[\w.-]+\/[\w.-]+$/.test(source.repository ?? "") ||
    typeof source.release !== "string" ||
    source.release.length === 0
  )
    throw new Error(
      'GH_REPLAY_SOURCE must name what is recorded, as {"repository": "OWNER/NAME", "release": "TAG"}',
    );
  return source;
}
