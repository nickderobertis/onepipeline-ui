"""Read-only, logged, quota-guarded GitHub REST access through this host's `gh`.

Every request this spike makes goes through `Reader.get`. Before each one it asks
`gh api rate_limit` (which GitHub does not count against the core quota) for the
core requests remaining, appends that figure to the request log, and refuses the
request when the figure is under the floor or the cap is reached. Only GET is ever
issued: `gh api` is invoked with `--method GET` and no body.
"""

from __future__ import annotations

import datetime as dt
import json
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path


class QuotaStop(RuntimeError):
    """Raised instead of making a request the floor or the cap forbids."""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _gh_json(path: str) -> object:
    out = subprocess.run(
        ["gh", "api", "--method", "GET", path],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(out.stdout)


@dataclass
class Reader:
    log_path: Path
    max_requests: int = 3000
    floor: int = 2500
    made: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        if self.log_path.exists():
            # A resumed fetch counts what earlier invocations already spent.
            for line in self.log_path.read_text().splitlines():
                entry = json.loads(line)
                if entry.get("kind") == "rest" and entry.get("counts_against_core", True):
                    self.made += 1

    def _log(self, entry: dict) -> None:
        with self.log_path.open("a") as fh:
            fh.write(json.dumps(entry, sort_keys=True) + "\n")

    def core_remaining(self) -> tuple[int, int]:
        # The rate-limit read is free of quota; a transient failure of it is
        # retried rather than ending the fetch, and never skipped.
        for attempt in range(3):
            try:
                body = _gh_json("rate_limit")
                break
            except subprocess.CalledProcessError as err:
                self._log({"at": _now(), "kind": "rate_limit_error", "counts_against_core": False,
                           "attempt": attempt + 1, "error": (err.stderr or "").strip()[:300]})
                if attempt == 2:
                    raise
                time.sleep(10)
        core = body["resources"]["core"]  # type: ignore[index]
        self._log(
            {
                "at": _now(),
                "kind": "rate_limit",
                "counts_against_core": False,
                "core_remaining": core["remaining"],
                "core_reset": core["reset"],
            }
        )
        return int(core["remaining"]), int(core["reset"])

    def get(self, path: str) -> object:
        if self.made >= self.max_requests:
            raise QuotaStop(f"request cap {self.max_requests} reached before {path}")
        remaining, _ = self.core_remaining()
        if remaining < self.floor:
            self._log({"at": _now(), "kind": "refused", "path": path, "core_remaining_before": remaining})
            raise QuotaStop(f"core remaining {remaining} < floor {self.floor} before {path}")
        self.made += 1
        entry = {
            "at": _now(),
            "kind": "rest",
            "method": "GET",
            "path": path,
            "seq": self.made,
            "core_remaining_before": remaining,
        }
        try:
            body = _gh_json(path)
        except subprocess.CalledProcessError as err:
            entry["error"] = (err.stderr or "").strip()[:500]
            self._log(entry)
            raise
        self._log(entry)
        return body
