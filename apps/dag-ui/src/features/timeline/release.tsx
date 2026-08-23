import { Alert, AlertDescription, AlertTitle } from "@oneharness/ui";
import type {
  NodeRelease as NodeReleaseRecord,
  ReleaseAwaited,
  TimelineRelease,
} from "@onepipeline-ui/dag-model";
import { UserRoundCheck } from "lucide-react";
import type { NodeView } from "../../lib/run-model";

/**
 * How a run's releases read, on the two surfaces that show them.
 *
 * A release is what makes "this node needs the *released* thing" a different
 * sequencing from "this node needs the *work*". Both readings live here — the
 * record a timeline item opened, and the release a node's own work went out in —
 * because the vocabulary is one vocabulary and two copies of it would agree only
 * for as long as nobody edited one.
 */

/**
 * The word a release style reads as.
 *
 * `automated` and `human-step` are the two `onevcs` writes, and the second is the
 * one that matters: it is the release nothing will do by itself. Anything else is
 * a style shipped by a producer newer than this build and reads as its own word
 * rather than as one of these two — the wire vocabulary is that library's and it
 * is released on its own schedule.
 */
export function releaseStyleLabel(style: string): string {
  return style === "human-step" ? "human step" : style;
}

/** Whether one wait is a wait on a person rather than on a machine. */
function needsAPerson(entry: ReleaseAwaited): boolean {
  return entry.style === "human-step";
}

/**
 * What the last look at one awaited release found, in the producer's four words.
 *
 * Spelled out because the words are terse enough to be read as their opposites:
 * `not-answered` is a probe that got no answer rather than a person who has not
 * replied, and `not-landed` is a release that exists but does not carry this
 * node's dependency yet. A word this build has never seen reads as itself.
 */
function lastAnswerLabel(answer: string): string {
  switch (answer) {
    case "not-released":
      return "not released yet";
    case "awaiting-human-step":
      return "waiting for the human step";
    case "not-answered":
      return "the registry did not answer";
    case "not-landed":
      return "released, but not carrying this work yet";
    default:
      return answer;
  }
}

/** One awaited release, named the way a reader would name it. */
function awaitedLabel(entry: ReleaseAwaited): string {
  return (
    [entry.identity, entry.target].filter(Boolean).join(" · ") || entry.dep
  );
}

/**
 * What one release record said about itself, for each of the six kinds that say
 * anything.
 *
 * Every field is shown only where the record carried it, which is what keeps one
 * reading honest for six kinds: a probe names an outcome and no commit, an
 * acknowledgement names a person and no probe, and neither is a gap in the other.
 *
 * The waits are the part a reader is scanning for. A node held on a machine will
 * clear itself; a node held on a **person** will not, and it is drawn as an alert
 * carrying the action somebody has to perform — so the reader can tell, without
 * opening anything else, which waits need somebody told.
 */
export function ReleaseRecord({
  release,
}: {
  readonly release: TimelineRelease;
}) {
  const facts: readonly (readonly [string, string])[] = [
    ...(release.dep === undefined
      ? []
      : ([["Dependency", release.dep]] as const)),
    ...(release.identity === undefined
      ? []
      : ([["Identity", release.identity]] as const)),
    ...(release.target === undefined
      ? []
      : ([["Release target", release.target]] as const)),
    ...(release.style === undefined
      ? []
      : ([["Style", releaseStyleLabel(release.style)]] as const)),
    ...(release.version === undefined
      ? []
      : ([["Version", release.version]] as const)),
    ...(release.outcome === undefined
      ? []
      : ([["Probe outcome", release.outcome]] as const)),
    ...(release.form === undefined
      ? []
      : ([["Probed through", release.form]] as const)),
    ...(release.elapsed_ms === undefined
      ? []
      : ([["Probe took", `${release.elapsed_ms} ms`]] as const)),
    ...(release.actor === undefined
      ? []
      : ([["Acknowledged by", release.actor]] as const)),
    ...(release.superseded === undefined
      ? []
      : ([
          [
            "Superseded",
            release.superseded
              ? "yes — a later acknowledgement replaced this one"
              : "no",
          ],
        ] as const)),
    ...(release.landing_commit === undefined
      ? []
      : ([["Landed as", release.landing_commit]] as const)),
    ...(release.delivery === undefined
      ? []
      : ([
          [
            "Adopted",
            release.delivery === "live"
              ? "Live — into the turn that was already running"
              : release.delivery,
          ],
        ] as const)),
  ];
  return (
    <>
      {facts.length > 0 && (
        <dl className="facts">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {release.awaiting !== undefined && (
        <>
          <h3 className="detail-heading">Held on</h3>
          <ul className="release-awaiting">
            {release.awaiting.map((entry) => (
              <li
                key={`${entry.dep}·${entry.identity ?? ""}·${entry.target ?? ""}`}
              >
                {needsAPerson(entry) ? (
                  <Alert>
                    <UserRoundCheck />
                    <AlertTitle>
                      Waiting on a person · {awaitedLabel(entry)}
                    </AlertTitle>
                    <AlertDescription>
                      {entry.action ??
                        "The release is a human step and the run recorded no action for it."}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <p className="detail-note">
                    Waiting on an automated release · {awaitedLabel(entry)}
                  </p>
                )}
                <p className="detail-note">
                  {[
                    entry.last_answer === undefined
                      ? undefined
                      : lastAnswerLabel(entry.last_answer),
                    entry.waited_seconds === undefined
                      ? undefined
                      : `waited ${entry.waited_seconds}s`,
                  ]
                    .filter((part) => part !== undefined)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {release.versions !== undefined && (
        <>
          <h3 className="detail-heading">Versions adopted</h3>
          <ul className="release-awaiting">
            {release.versions.map((version) => (
              <li key={`${version.identity}·${version.target}`}>
                <p className="detail-note">
                  {version.identity} · {version.target} · {version.version}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * The release a node's own work went out in, beside the change request that
 * opened it.
 *
 * The identity is shown only where it is not the node's own repository: a node
 * that published its own repository names it in every row already, and repeating
 * it is noise a reader has to read past to find the target and the version. A
 * node whose plan names no repository is shown the identity, because nothing here
 * can say it is the same one.
 */
export function NodeRelease({ node }: { readonly node: NodeView }) {
  const release: NodeReleaseRecord | undefined =
    node.result?.release ?? undefined;
  if (release === undefined) return <>Not recorded</>;
  const elsewhere = release.identity !== node.task.repo;
  return (
    <>
      {[
        release.target,
        release.style === undefined
          ? undefined
          : releaseStyleLabel(release.style),
        release.version,
        elsewhere ? release.identity : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" · ")}
    </>
  );
}
