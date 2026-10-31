"""Loopback GitHub board for the engine-driven read journeys over a remote plan.

Answers come from mutable board state; unknown operations are refused. The real
released GitHub plugin and engine read and project through this HTTP boundary.
Adapted from onepipeline 0.70.0's tests/e2e/github_loopback.py, and from 0.79.0's
for the read of issues by repository and number a landing's closures make.

An optional second argument names a JSON seed replacing the default plan and its
one approval: `{"repository": "owner/name", "options": [...], "issues": {NAME:
{"number": N, "title": T, "content": C, "metadata": {...}, "status": OPTION,
"state": "OPEN" | "CLOSED", "reason": null | REASON, "parent": NAME | null}}}`.
"""
import argparse
import json
import os
import pathlib
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import TCPServer

def directory(value):
    path = pathlib.Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise argparse.ArgumentTypeError("board root must be an existing absolute directory")
    return path.resolve()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=directory)
parser.add_argument("seed", nargs="?", type=pathlib.Path)
arguments = parser.parse_args()
root = arguments.root
token = os.environ.get("CACHE_BOARD_TOKEN", "")
if not token.strip():
    parser.error("CACHE_BOARD_TOKEN must contain a nonempty board credential")
# llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] This task requires a
# loopback board stand-in at the real remote plugin's HTTP boundary. These are fixture
# responses for the released plugin, not an API definition shipped to consumers; the
# journey drives that unmodified plugin and refuses unsupported operations here. Importing
# its Rust record types would not describe GitHub's GraphQL wire or exercise its parser.
options = ["Todo", "Queued", "In Progress", "Needs Attention", "Done", "Canceled"]


def connection(nodes):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": False, "endCursor": None}}


def field():
    return {"__typename": "ProjectV2SingleSelectField", "id": "STATUS", "name": "Status",
            "options": [{"id": name, "name": name} for name in options]}


# The board's Priority field, which a source with a `priority_mapping` writes a task's
# priority to; its options are the board's own names for the four priorities.
priorities = ["Urgent", "High", "Medium", "Low"]


def priority_field():
    return {"__typename": "ProjectV2SingleSelectField", "id": "PRIORITY", "name": "Priority",
            "options": [{"id": name, "name": name} for name in priorities]}


# The source-owned text field a projected task's origin is written to.
ORIGIN = "onetaskgraph.origin"


def origin_field():
    return {"__typename": "ProjectV2Field", "id": "ORIGIN", "name": ORIGIN, "dataType": "TEXT"}


def board_fields():
    return [field(), priority_field(), origin_field()]


def described(content, metadata):
    return content + "\n\n<!-- onetaskgraph.metadata\n" + json.dumps(metadata) + "\n-->"


STATES = {"OPEN": [None], "CLOSED": ["COMPLETED", "NOT_PLANNED", "DUPLICATE"]}
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SEEDED = {"number", "title", "content", "metadata", "status", "state", "reason", "parent"}
# What a seeded issue may say beside those: the issues it is blocked by, which GitHub
# serves as its `blockedBy` relationships.
OPTIONAL = {"blocked_by"}


def default_seed():
    """The plan and its one approval every journey that names no seed reads."""
    issues = {}
    for name in ["plan", "approve"]:
        metadata = ({"onepipeline.schema_version": 3, "onepipeline.concurrency": 1,
                     "onepipeline.goal": {"text": "Keep people's board edits"}}
                    if name == "plan" else
                    {"onepipeline.id": name, "onepipeline.kind": "human",
                     "onetaskgraph.repositories": []})
        content = "" if name == "plan" else (
            f"## What\nDo {name}.\n\n## Why\nSo the run can settle.\n\n## Acceptance criteria\n- {name} is done.")
        issues[name] = {"number": 1, "title": "cached-approval" if name == "plan" else name,
                        "content": content, "metadata": metadata, "status": "Todo",
                        "state": "OPEN", "reason": None,
                        "parent": None if name == "plan" else "plan"}
    return {"repository": "generic/approval", "options": options, "issues": issues}


def checked(seed):
    """A journey's seed, refused unless every part is one this board can answer as GitHub
    would: open issues carry no reason, closed ones one GitHub closes with, every card sits at
    one of the board's options, and every parent is an issue of the seed."""
    if (not isinstance(seed, dict) or set(seed) != {"repository", "options", "issues"}
            or not isinstance(seed["repository"], str) or not REPOSITORY.match(seed["repository"])
            or not isinstance(seed["options"], list) or not seed["options"]
            or not all(isinstance(option, str) and option for option in seed["options"])
            or not isinstance(seed["issues"], dict) or not seed["issues"]):
        parser.error("a seed names a repository, its Status options and its issues")
    for name, held in seed["issues"].items():
        if (not isinstance(held, dict) or not SEEDED <= set(held) <= SEEDED | OPTIONAL
                or not all(isinstance(blocker, str) and blocker in seed["issues"]
                           and blocker != name for blocker in held.get("blocked_by", []))
                or not isinstance(held["number"], int) or isinstance(held["number"], bool)
                or held["number"] < 1
                or not all(isinstance(held[key], str) for key in ["title", "content"])
                or not isinstance(held["metadata"], dict)
                or not all(isinstance(held[key], str) for key in ["status", "state"])
                or held["status"] not in seed["options"]
                or held["reason"] not in STATES.get(held["state"], [])
                or not (held["parent"] is None
                        or (isinstance(held["parent"], str) and held["parent"] in seed["issues"]))):
            parser.error(f"seeded issue {name!r} does not fit the board")
    numbers = [held["number"] for held in seed["issues"].values()]
    if len(set(numbers)) != len(numbers):
        parser.error("two seeded issues share a number, which one repository never does")
    for name in seed["issues"]:
        # A parent chain ends at an issue with none: one that returns to an issue
        # already on it is a cycle GitHub's sub-issues refuse.
        seen = {name}
        parent = seed["issues"][name]["parent"]
        while parent is not None:
            if parent in seen:
                parser.error(f"seeded issue {name!r} is its own ancestor")
            seen.add(parent)
            parent = seed["issues"][parent]["parent"]
    return seed


def read_seed(path):
    """The seed `path` holds, or a usage error for one that is not there or not JSON."""
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        parser.error(f"the seed {path} is not readable JSON: {error}")


seed = checked(read_seed(arguments.seed)) if arguments.seed else default_seed()
options = seed["options"]
state = {"repository": seed["repository"], "issues": {}, "requests": []}
for name, held in seed["issues"].items():
    state["issues"][name] = {"body": described(held["content"], held["metadata"]),
                             "status": held["status"], "state": held["state"],
                             "reason": held["reason"], "title": held["title"],
                             "number": held["number"], "parent": held["parent"],
                             "blocked_by": list(held.get("blocked_by", []))}


def children(name):
    return [child for child, held in state["issues"].items() if held["parent"] == name]


def issue(name, membership_of=None):
    """The issue GitHub answers for `name`: every board membership carrying its card's
    `Status`, as a board read's `fieldValues` or, by `membership_of`, as a read by reference
    asks for it."""
    held = state["issues"][name]
    values = ([] if held["status"] is None else
              [{"name": held["status"], "optionId": held["status"], "field": field()}])
    if held.get("priority") is not None:
        values.append({"name": held["priority"], "optionId": held["priority"],
                       "field": priority_field()})
    if held.get("origin") is not None:
        values.append({"text": held["origin"],
                       "field": {"id": "ORIGIN", "name": ORIGIN}})
    membership = {"id": "ITEM-" + name, "project": {"id": "BOARD", "number": 1},
                  "fieldValues": connection(values), "updatedAt": "2026-01-01T00:00:00Z"}
    if membership_of is not None:
        membership = membership_of(membership, values[0] if values else None)
    value = {"__typename": "Issue", "id": name, "title": held["title"],
             "body": held["body"], "state": held["state"], "stateReason": held["reason"],
             "number": held["number"],
             "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
             "repository": {"nameWithOwner": state["repository"]},
             "commentCount": {"totalCount": 0}, "relationshipEvents": {"totalCount": 0},
             "url": held.get("url"), "parent": None if held["parent"] is None else {"id": held["parent"]},
             "subIssuesSummary": {"total": len(children(name))},
             "labels": connection([]), "projectItems": connection([membership]),
             "blockedBy": connection([related(blocker)
                                      for blocker in held.get("blocked_by", [])]),
             "blocking": connection([related(other) for other, by in state["issues"].items()
                                     if name in by.get("blocked_by", [])])}
    if children(name):
        value["subIssues"] = connection([issue(child) for child in children(name)])
    return value


def related(name):
    """An issue as a relationship names it: the `Related` fields a source reads."""
    held = state["issues"][name]
    return {"__typename": "Issue", "id": name, "title": held["title"], "body": held["body"],
            "parent": None if held["parent"] is None else {"id": held["parent"]},
            "subIssuesSummary": {"total": len(children(name))}}


def by_reference(membership, status):
    """A membership as a read by reference selects it: its `Status` by name, no other field."""
    return {"id": membership["id"], "updatedAt": membership["updatedAt"],
            "project": membership["project"],
            "status": None if status is None else {"name": status["name"],
                                                   "field": status["field"]}}


def issues_by_reference(variables):
    """Every `r<slot>` alias of a read by repository and number: the issue this board holds
    under that number, or GitHub's `NOT_FOUND` for a repository or issue it does not."""
    data, errors = {}, []
    slot = 0
    while "owner%d" % slot in variables:
        owner, name = variables["owner%d" % slot], variables.get("name%d" % slot)
        number = variables.get("number%d" % slot)
        if (not isinstance(owner, str) or not isinstance(name, str)
                or not isinstance(number, int) or isinstance(number, bool) or number < 1):
            raise ValueError("slot %d of a read by reference names no owner, name and number" % slot)
        held = [held_name for held_name, held in state["issues"].items()
                if held["number"] == number]
        if "%s/%s" % (owner, name) != state["repository"]:
            data["r%d" % slot] = None
            errors.append({"type": "NOT_FOUND", "path": ["r%d" % slot],
                           "message": "Could not resolve to a Repository"})
        elif not held:
            data["r%d" % slot] = {"issue": None}
            errors.append({"type": "NOT_FOUND", "path": ["r%d" % slot, "issue"],
                           "message": "Could not resolve to an issue"})
        else:
            data["r%d" % slot] = {"issue": issue(held[0], by_reference)}
        slot += 1
    answer = {"data": data}
    if errors:
        answer["errors"] = errors
    return answer


def write_field(supplied, clear=False):
    keys = {"projectId", "itemId", "fieldId"} if clear else {"projectId", "itemId", "fieldId", "value"}
    if (not isinstance(supplied, dict) or set(supplied) != keys
            or supplied["projectId"] != "BOARD"
            or supplied["itemId"] not in ["ITEM-" + name for name in state["issues"]]):
        raise ValueError("invalid field mutation input")
    held = state["issues"][supplied["itemId"].removeprefix("ITEM-")]
    selected = (None if clear or not isinstance(supplied["value"], dict)
                or set(supplied["value"]) != {"singleSelectOptionId"}
                else supplied["value"]["singleSelectOptionId"])
    if supplied["fieldId"] == "STATUS" and selected in options:
        held["status"] = selected
    elif supplied["fieldId"] == "PRIORITY" and (clear or selected in priorities):
        held["priority"] = selected
    elif supplied["fieldId"] == "ORIGIN" and clear:
        held["origin"] = None
    elif (supplied["fieldId"] == "ORIGIN" and isinstance(supplied["value"], dict)
          and set(supplied["value"]) == {"text"} and isinstance(supplied["value"]["text"], str)):
        held["origin"] = supplied["value"]["text"]
    else:
        raise ValueError("invalid field mutation input")
    return {"projectV2Item": {"id": supplied["itemId"]}}


# The aliases of the one mutation a source writes a projected card's fields in: each
# update or clear is made only when its `@include` flag is set, in the order written.
BATCHED = [("updateProjectV2ItemFieldValue", "input", "writeFirst", False),
           ("second", "second", "writeSecond", False), ("third", "third", "writeThird", False),
           ("fourth", "fourth", "writeFourth", False), ("fifth", "fifth", "writeFifth", False),
           ("sixth", "sixth", "writeSixth", False), ("cleared", "clear", "writeClear", True),
           ("clearedSecond", "clearSecond", "writeClearSecond", True),
           ("clearedThird", "clearThird", "writeClearThird", True)]


def batched_fields(query, variables):
    data = {}
    for alias, name, flag, clear in BATCHED:
        if ("$" + flag) not in query or not isinstance(variables.get(flag), bool):
            raise ValueError("the batched field update names no %s flag" % flag)
        if variables[flag]:
            data[alias] = write_field(variables.get(name), clear)
    return data


def create_issue(supplied):
    """`createIssue`: a new open issue in the board's one repository, numbered after every
    issue it holds, linked under its parent when one is named, and GitHub's own URL for it."""
    if (not isinstance(supplied, dict) or supplied.get("repositoryId") != "REPOSITORY"
            or not isinstance(supplied.get("title"), str) or not supplied["title"].strip()
            or not isinstance(supplied.get("body", ""), str)
            or set(supplied) - {"repositoryId", "title", "body", "parentIssueId"}
            or supplied.get("parentIssueId") not in [None, *state["issues"]]):
        raise ValueError("invalid createIssue input")
    number = max([held["number"] for held in state["issues"].values()], default=0) + 1
    name = "I_%d" % number
    state["issues"][name] = {"body": supplied.get("body", ""), "status": None, "state": "OPEN",
                             "reason": None, "title": supplied["title"], "number": number,
                             "parent": supplied.get("parentIssueId"), "member": False,
                             "url": "https://github.com/%s/issues/%d" % (state["repository"],
                                                                         number)}
    return name


def add_item(supplied):
    """`addProjectV2ItemById`: the issue put on the board, once."""
    if (not isinstance(supplied, dict) or set(supplied) != {"projectId", "contentId"}
            or supplied["projectId"] != "BOARD" or supplied["contentId"] not in state["issues"]):
        raise ValueError("invalid addProjectV2ItemById input")
    state["issues"][supplied["contentId"]]["member"] = True
    return {"item": {"id": "ITEM-" + supplied["contentId"]}}


def save():
    staged = root / "state.next"
    staged.write_text(json.dumps(state))
    staged.replace(root / "state.json")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, answer, status=200):
        encoded = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        if self.headers.get("Authorization") != f"Bearer {token}":
            self.reply({"errors": [{"message": "invalid board token"}]}, 401)
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
            if not 0 < length <= 262144:
                raise ValueError("Content-Length must be between 1 and 262144")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            if self.path == "/graphql":
                answer = self.graphql(request)
            else:
                raise ValueError("unknown route")
        except (ValueError, TypeError, KeyError) as error:
            self.reply({"errors": [{"message": str(error)}]}, 400)
            return
        save()
        self.reply(answer)

    def graphql(self, request):
        query = request.get("query")
        variables = request.get("variables")
        if (not isinstance(query, str) or not query.strip()
                or not isinstance(variables, dict)
                or set(request) - {"query", "variables", "operationName"}
                or (request.get("operationName") is not None
                    and not isinstance(request["operationName"], str))):
            raise ValueError("GraphQL requires a query string and an object of variables")
        state["requests"].append(request)
        if "r0:repository(owner:$owner0" in query:
            return issues_by_reference(variables)
        if "updateIssue(" in query:
            supplied = variables.get("input")
            if (not isinstance(supplied, dict) or not isinstance(supplied.get("id"), str)
                    or supplied["id"] not in state["issues"]
                    or set(supplied) - {"id", "body", "title", "stateInput"}):
                raise ValueError("invalid issue mutation input")
            for key in ["body", "title"]:
                if key in supplied and not isinstance(supplied[key], str):
                    raise ValueError(key + " must be a string")
            movement = supplied.get("stateInput")
            if movement is not None and (not isinstance(movement, dict)
                    or movement.get("value") not in ["OPEN", "CLOSED"]
                    or set(movement) - {"value", "stateReason"}
                    or movement.get("stateReason") not in [None, "COMPLETED", "NOT_PLANNED"]):
                raise ValueError("invalid issue state input")
            held = state["issues"][supplied["id"]]
            if "title" in supplied:
                held["title"] = supplied["title"]
            if "body" in supplied:
                held["body"] = supplied["body"]
            if movement is not None:
                held["state"] = movement["value"]
                held["reason"] = movement.get("stateReason")
            return {"data": {"updateIssue": {"issue": issue(supplied["id"])}}}
        if "createIssue(" in query:
            return {"data": {"createIssue": {"issue": issue(create_issue(variables.get("input")))}}}
        if "addSubIssue(" in query:
            supplied = variables.get("input")
            if (not isinstance(supplied, dict) or set(supplied) != {"issueId", "subIssueId"}
                    or supplied["issueId"] not in state["issues"]
                    or supplied["subIssueId"] not in state["issues"]
                    or supplied["issueId"] == supplied["subIssueId"]):
                raise ValueError("invalid addSubIssue input")
            state["issues"][supplied["subIssueId"]]["parent"] = supplied["issueId"]
            return {"data": {"addSubIssue": {"issue": {"id": supplied["issueId"]},
                                             "subIssue": {"id": supplied["subIssueId"]}}}}
        if "addProjectV2ItemById(" in query:
            return {"data": {"addProjectV2ItemById": add_item(variables.get("input"))}}
        if "second:updateProjectV2ItemFieldValue(" in query:
            return {"data": batched_fields(query, variables)}
        if "updateProjectV2ItemFieldValue(" in query:
            written = write_field(variables.get("input"))
            if "content{" in query:
                # The card's issue, read back in the same request: what a source
                # settling a projected task checks it settled.
                name = variables["input"]["itemId"].removeprefix("ITEM-")
                written["projectV2Item"]["content"] = {**issue(name), "comments": connection([])}
            return {"data": {"updateProjectV2ItemFieldValue": written}}
        if "clearProjectV2ItemFieldValue(" in query:
            return {"data": {"clearProjectV2ItemFieldValue": write_field(variables.get("input"), True)}}
        if "node(id:" in query:
            name = variables.get("id")
            if not isinstance(name, str) or name not in state["issues"]:
                raise ValueError("unknown issue id")
            return {"data": {"node": issue(name)}}
        if "repositoryOwner(" in query:
            board = {"id": "BOARD", "title": "Board",
                     "fields": connection(board_fields()),
                     "items": connection([{"id": "ITEM-" + name, "updatedAt": "2026-01-01T00:00:00Z",
                                            "content": issue(name),
                                            "fieldValues": issue(name)["projectItems"]["nodes"][0]["fieldValues"]}
                                           for name in state["issues"]])}
            alias = "boardFields" if "boardFields:" in query else "owner"
            data = {alias: {"projectV2": board}}
            if "repository(owner:$repositoryOwner" in query:
                # The repository a task is created in, asked beside the board's fields.
                held = "%s/%s" % (variables.get("repositoryOwner"), variables.get("repositoryName"))
                data["repository"] = ({"id": "REPOSITORY", "nameWithOwner": state["repository"]}
                                      if held == state["repository"] else None)
            return {"data": data}
        return {"errors": [{"message": "unsupported loopback operation: " + query}]}

# llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

class LoopbackServer(HTTPServer):
    def server_bind(self):
        # HTTPServer resolves getfqdn even for a numeric loopback address. macOS
        # can block there before publishing the endpoint. This board needs only
        # the bound address, so binding must not depend on the host's DNS.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


server = LoopbackServer(("127.0.0.1", 0), Handler)
save()
# Published by rename, so the reader that waits for `endpoint` to exist never
# reads it before its URL is in it.
(root / "endpoint.partial").write_text(f"http://127.0.0.1:{server.server_port}")
os.replace(root / "endpoint.partial", root / "endpoint")
server.serve_forever()
