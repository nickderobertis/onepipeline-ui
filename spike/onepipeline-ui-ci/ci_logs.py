#!/usr/bin/env python3
"""Read CI's own per-target timings out of a few job logs.

    python3 -I spike/onepipeline-ui-ci/ci_logs.py --repo nickderobertis/onepipeline-ui \
        --raw spike/onepipeline-ui-ci/raw --shape-since 2026-10-13T22:56:32Z --per-job 3 \
        --out spike/onepipeline-ui-ci/ci-logs.json

For each named job, the newest `--per-job` successful runs of it created at or
after --shape-since have their log read (one logged, quota-guarded REST request
each, through ghread.py; cached under raw/logs/), and from each log it takes what
Nx and the test runners print themselves: every Nx invocation's
`Successfully ran target …` / `Run duration:` summary, nextest's `Summary [ Ns ]`
lines, Playwright's `N passed (…)` line and Vitest's `Duration`, and each step's
`##[group]Run …` start. `--offline` reads raw/logs/ only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure as m  # noqa: E402
from ghread import QuotaStop, Reader  # noqa: E402

JOBS = [
    ("CI", "pull_request", "quality"),
    ("CI", "pull_request", "sweep"),
    ("CI", "pull_request", "cross (windows-latest)"),
    ("Release", "release", "test"),
]
STAMP = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def duration_text(text: str) -> float | None:
    total, found = 0.0, False
    for value, unit in re.findall(r"([\d.]+)\s*(h|m|ms|s)\b", text):
        found = True
        total += float(value) * {"h": 3600, "m": 60, "s": 1, "ms": 0.001}[unit]
    return round(total, 1) if found else None


def parse(log: str) -> dict:
    invocations, nextest, playwright, vitest, steps, longest = [], [], [], [], [], []
    pending = None
    for raw in log.splitlines():
        mm = STAMP.match(raw)
        stamp, line = (mm.group(1), ANSI.sub("", mm.group(2))) if mm else (None, ANSI.sub("", raw))
        if line.startswith("##[group]Run "):
            steps.append({"at": stamp, "step": line[len("##[group]Run "):][:120]})
        if mt := re.search(r"(Successfully ran|Ran) target ([\w-]+(?: [\w-]+)*?) for (\d+) projects?", line):
            pending = {"at": stamp, "targets": mt.group(2), "projects": int(mt.group(3)), "line": line.strip()[:200]}
        elif re.search(r"Running target ([\w-]+(?: [\w-]+)*?) for (\d+) projects? failed", line):
            pending = {"at": stamp, "targets": line.strip()[:120], "failed": True}
        elif pending and (md := re.search(r"Run duration:\s+(.+)$", line)):
            pending["run_duration_s"] = duration_text(md.group(1))
            invocations.append(pending)
            pending = None
        elif mn := re.search(r"Summary \[\s*([\d.]+)s\]\s+(.*)$", line):
            nextest.append({"at": stamp, "seconds": float(mn.group(1)), "summary": mn.group(2)[:160]})
        elif mp := re.search(r"^\s*(\d+) passed \((.+)\)\s*$", line):
            playwright.append({"at": stamp, "passed": int(mp.group(1)), "seconds": duration_text(mp.group(2))})
        elif mv := re.search(r"^\s*Duration\s+([\d.]+m?s)", line):
            vitest.append({"at": stamp, "seconds": duration_text(mv.group(1))})
        elif ml := re.search(r"^\s+([\w-]+:[\w-]+)\s+((?:\d+h )?(?:\d+m )?[\d.]+m?s)\s*$", line):
            longest.append({"at": stamp, "task": ml.group(1), "seconds": duration_text(ml.group(2))})
    return {"nx_invocations": invocations, "nextest_summaries": nextest, "playwright": playwright,
            "vitest": vitest, "critical_path_tasks": longest, "steps": steps}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--shape-since", required=True)
    ap.add_argument("--per-job", type=int, default=3)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()
    since = m.ts(args.shape_since)
    runs, jobs = m.load_runs(args.raw), m.load_jobs(args.raw)
    reader = None if args.offline else Reader(args.raw.parent / "request-log.jsonl")
    out = []
    for wf, event, name in JOBS:
        cands = []
        for rid, js in jobs.items():
            r = runs.get(rid)
            if not r or r["name"] != wf or r["event"] != event or m.ts(r["created_at"]) < since:
                continue
            cands += [(j, r) for j in js if j["name"] == name and j.get("conclusion") == "success"]
        cands.sort(key=lambda jr: jr[0]["started_at"], reverse=True)
        for j, r in cands[: args.per_job]:
            dest = args.raw / "logs" / f"{j['id']}.log"
            if not dest.exists():
                if reader is None:
                    continue
                try:
                    text = reader.get(f"repos/{args.repo}/actions/jobs/{j['id']}/logs", raw=True)
                except QuotaStop as err:
                    print(f"stopped: {err}", file=sys.stderr)
                    reader = None
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(text)
            out.append({"workflow": wf, "event": event, "job": name, "job_id": j["id"], "run_id": r["id"],
                        "duration_s": m.job_dur(j), "head_sha": r["head_sha"], **parse(dest.read_text(errors="replace"))})
    args.out.write_text(json.dumps(out, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
