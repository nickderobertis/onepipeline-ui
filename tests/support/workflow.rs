//! Reading this repository's GitHub Actions workflows the way the journeys that
//! hold them need to.
//!
//! A YAML parser would be a dependency for a fixed two-level shape: job ids are
//! the keys indented by exactly two spaces under the top-level `jobs:`, and what a
//! journey asserts about a job is a line inside its block.
//!
//! Linux only because the one journey module reading it, `linux_wheel`, is: it
//! runs the Linux wheel scripts those workflows call. Compiling it anywhere else
//! leaves `job_block` unused, which `-D warnings` refuses on the macOS leg.
#![cfg(target_os = "linux")]

use std::fs;
use std::path::Path;

/// One job's block of a workflow: from `  <job>:` to the next job key at the
/// same indentation.
pub fn job_block(workflow: &str, job: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(".github/workflows")
        .join(workflow);
    let text =
        fs::read_to_string(&path).unwrap_or_else(|error| panic!("{workflow} is readable: {error}"));
    let header = format!("  {job}:");
    let mut lines = text.lines().skip_while(|line| *line != header);
    let first = lines
        .next()
        .unwrap_or_else(|| panic!("{workflow} has a `{job}` job"));
    let body = lines.take_while(|line| {
        let inner = line.strip_prefix("  ").unwrap_or("");
        !(line.starts_with("  ") && !inner.starts_with([' ', '#']) && inner.ends_with(':'))
    });
    std::iter::once(first)
        .chain(body)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
