#!/usr/bin/env python3
"""Time one of the repository's own recipes and every Nx task it ran.

    python3 -I spike/onepipeline-ui-ci/local_profile.py --label check-cold \
        --out spike/onepipeline-ui-ci/local/check-cold.json -- just check

Runs the command from the repository root with its output in a log beside --out,
then reads what Nx itself recorded for each task that invocation ran — start, end,
and whether it executed or replayed from the cache — out of Nx's task-history
database (`.nx/workspace-data/*.db`, table `task_history` joined to
`task_details`). Per-test durations come from each runner's own output in the log:
nextest's `PASS [  12.345s] binary test` lines (the run sets
`NEXTEST_STATUS_LEVEL=pass` so every pass is printed), Playwright's list reporter
`✓ … (1.2s)` lines, and bun's `(pass) … [12.34ms]` lines.

`--parse-only LOG` re-reads a log and the database rows recorded in an existing
--out without running anything.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def db_path() -> Path | None:
    found = sorted(glob.glob(str(ROOT / ".nx/workspace-data/*-v*.db")))
    return Path(found[-1]) if found else None


def max_history_id() -> int:
    p = db_path()
    if p is None:
        return 0
    with sqlite3.connect(p) as c:
        return c.execute("select coalesce(max(id), 0) from task_history").fetchone()[0]


def tasks_since(first_id: int) -> list[dict]:
    p = db_path()
    if p is None:
        return []
    with sqlite3.connect(p) as c:
        rows = c.execute(
            "select h.id, d.project, d.target, h.status, h.code, h.start, h.end "
            "from task_history h join task_details d on d.hash = h.hash "
            "where h.id > ? order by h.start",
            (first_id,),
        ).fetchall()
    return [
        {"id": r[0], "task": f"{r[1]}:{r[2]}", "status": r[3], "code": r[4],
         "seconds": round((r[6] - r[5]) / 1000, 1), "start_ms": r[5], "end_ms": r[6]}
        for r in rows
    ]


NEXTEST = re.compile(r"^\s*PASS \[\s*([\d.]+)s\]\s+(?:\(\s*\d+/\d+\)\s+)?(\S+)\s+(\S+)")
PLAYWRIGHT = re.compile(r"✓\s+\d+\s+(.+?)\s+\(([\d.]+)(m?s)\)\s*$")
BUN = re.compile(r"\(pass\)\s+(.+?)\s+\[([\d.]+)(m?s)\]\s*$")


def tests_from_log(text: str) -> list[dict]:
    out = []
    project = None
    for raw in text.splitlines():
        line = ANSI.sub("", raw)
        m = re.match(r"^> nx run (\S+)", line.strip())
        if m:
            project = m.group(1)
            continue
        if m := NEXTEST.match(line):
            out.append({"runner": "nextest", "task": project, "binary": m.group(2), "test": m.group(3), "seconds": float(m.group(1))})
        elif m := PLAYWRIGHT.search(line):
            v = float(m.group(2)) / (1000 if m.group(3) == "ms" else 1)
            out.append({"runner": "playwright", "task": project, "test": m.group(1).strip(), "seconds": v})
        elif m := BUN.search(line):
            v = float(m.group(2)) / (1000 if m.group(3) == "ms" else 1)
            out.append({"runner": "bun", "task": project, "test": m.group(1).strip(), "seconds": v})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--note", default="")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    log = args.out.with_suffix(".log")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    first = max_history_id()
    env = dict(os.environ, NEXTEST_STATUS_LEVEL="pass")
    t0 = time.time()
    with log.open("w") as fh:
        rc = subprocess.run(cmd, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, env=env).returncode
    t1 = time.time()
    tasks = tasks_since(first)
    tests = sorted(tests_from_log(log.read_text(errors="replace")), key=lambda t: -t["seconds"])
    doc = {
        "label": args.label, "command": cmd, "note": args.note, "exit_code": rc,
        "wall_seconds": round(t1 - t0, 1), "started_at": t0,
        "nx_cache_entries_before": None,
        "tasks": tasks,
        "tasks_executed": sum(1 for t in tasks if t["status"] == "success"),
        "tasks_replayed": sum(1 for t in tasks if "cache" in (t["status"] or "")),
        "tests_parsed": len(tests),
        "slowest_tests": tests[:40],
    }
    args.out.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: doc[k] for k in ("label", "exit_code", "wall_seconds", "tasks_executed", "tasks_replayed", "tests_parsed")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
