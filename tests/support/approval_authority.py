"""The approval authority a design review completes through, in the journeys.

A host configures its own approval command, which lives outside this
repository; the journeys configure this one in its place, as they double the
tracker. Run as `python3 approval_authority.py VERSIONS LOG`: `VERSIONS` is a
JSON object naming the current version of each design document, and `LOG` is
the newline-delimited file every approval record is appended to.

The engine writes `{board_copy, key, actor, on_behalf_of}` on stdin. Asked to
approve the version it holds as current, this appends the approval record and
answers that version; asked about another, it records nothing and answers the
current one, which the engine compares with the stored key. A document it does
not hold exits 3; input that is not the shape above exits 2, before anything is
recorded.

Run as `python3 approval_authority.py --undo VERSIONS LOG` it is the same
authority's configured `undo`: it reads the same request, removes the approval
record of exactly that document and version from `LOG` and answers
`{board_copy, key}` naming it. With no such record to remove it exits 1 and says
why on standard error, which the engine shows as the reopen's refusal.
"""

import json
import sys

REQUEST = {"board_copy", "key", "actor", "on_behalf_of"}


def refuse(message):
    sys.stderr.write(f"approval_authority: {message}\n")
    sys.exit(2)


def text(value):
    return isinstance(value, str) and value.strip() != ""


def undo(request, log_path):
    """Remove the approval `request` names from the log, or refuse saying why."""
    try:
        with open(log_path) as log:
            records = [json.loads(line) for line in log if line.strip()]
    except OSError:
        records = []
    wanted = (request["board_copy"], request["key"])
    kept = [r for r in records if (r["board_copy"], r["key"]) != wanted]
    if len(kept) == len(records):
        sys.stderr.write(
            f"no approval of {request['board_copy']} at {request['key']} is recorded, "
            "so there is nothing to take back\n")
        sys.exit(1)
    with open(log_path, "w") as log:
        log.writelines(json.dumps(r) + "\n" for r in kept)
    print(json.dumps({"board_copy": request["board_copy"], "key": request["key"]}))


def main():
    undoing = sys.argv[1:2] == ["--undo"]
    if undoing:
        del sys.argv[1]
    if len(sys.argv) != 3:
        refuse("usage: approval_authority.py [--undo] VERSIONS LOG")
    try:
        request = json.load(sys.stdin)
        with open(sys.argv[1]) as held:
            versions = json.load(held)
    except (OSError, ValueError) as error:
        refuse(f"unreadable input: {error}")
    if not isinstance(request, dict) or set(request) != REQUEST:
        refuse("the request must be an object of exactly " + ", ".join(sorted(REQUEST)))
    if not all(text(request[name]) for name in ["board_copy", "key", "actor"]):
        refuse("board_copy, key and actor must be non-empty strings")
    if request["on_behalf_of"] is not None and not text(request["on_behalf_of"]):
        refuse("on_behalf_of must be null or a non-empty string")
    if not isinstance(versions, dict) or not all(
            text(name) and text(version) for name, version in versions.items()):
        refuse("the versions file must map each document to a non-empty version")
    if undoing:
        undo(request, sys.argv[2])
        return
    current = versions.get(request["board_copy"])
    if current is None:
        sys.exit(3)
    if current == request["key"]:
        with open(sys.argv[2], "a") as log:
            log.write(json.dumps({"board_copy": request["board_copy"], "key": current,
                                  "actor": request["actor"],
                                  "on_behalf_of": request["on_behalf_of"]}) + "\n")
    print(json.dumps({"board_copy": request["board_copy"], "key": current}))


if __name__ == "__main__":
    main()
