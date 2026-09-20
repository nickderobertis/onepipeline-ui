import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  ScrollArea,
  Skeleton,
} from "@oneharness/ui";
import type { ProjectGroup, RunSummary } from "@onepipeline-ui/dag-model";
import { ChevronRight, FolderKanban, TriangleAlert } from "lucide-react";
import { nodeCountSummary } from "../../lib/run-model";
import { StateBadge } from "../../lib/StateBadge";
import { Timestamp } from "../../lib/Timestamp";
import {
  isoOfMillis,
  projectKeyOf,
  projectLabel,
  runCount,
  runStateSummary,
} from "./project-model";

/**
 * The landing view: every project the root holds, as cards, in the server's own
 * order. What the run list used to be, one level up — a manager reads a host by
 * project first, and a project opens to the DAGs launched against it.
 */
export function ProjectsLanding({
  groups,
  error,
  onSelect,
}: {
  readonly groups?: readonly ProjectGroup[];
  readonly error?: Error;
  readonly onSelect: (projectKey: string) => void;
}) {
  return (
    <ScrollArea className="h-full">
      <section aria-labelledby="projects-heading" className="projects-landing">
        <h2 id="projects-heading">Projects</h2>
        <p className="projects-lede">
          Every project with a run under this root, newest activity first.
        </p>
        {error && <ReadFailed error={error} what="The project list" />}
        {groups === undefined ? (
          <div aria-live="polite" className="loading-state">
            <Skeleton className="h-2 w-48" />
            <Skeleton className="h-2 w-32" />
            Loading projects…
          </div>
        ) : groups.length === 0 ? (
          <div className="empty-state">
            <FolderKanban size={34} />
            <h2>No DAG runs found</h2>
            <p>Start an orchestrated run to see its project appear here.</p>
          </div>
        ) : (
          <ul aria-label="Projects" className="project-cards">
            {groups.map((group) => (
              <li key={projectKeyOf(group)}>
                <Card className="project-card">
                  <CardContent>
                    <button
                      className="project-card-open"
                      onClick={() => onSelect(projectKeyOf(group))}
                      type="button"
                    >
                      <span className="project-card-name">
                        {projectLabel(group)}
                      </span>
                      <ChevronRight aria-hidden="true" size={14} />
                    </button>
                    {group.project !== null && (
                      <p className="project-card-id">{group.project}</p>
                    )}
                    <p className="project-card-facts">
                      {runCount(group.runs)}
                      {group.runs.length > 0 &&
                        ` · ${runStateSummary(group.runs)}`}
                    </p>
                    <p className="project-card-facts">
                      {group.last_write_at === null ? (
                        "never written"
                      ) : (
                        <>
                          Last activity{" "}
                          <Timestamp
                            at={isoOfMillis(group.last_write_at)}
                            relative
                          />
                        </>
                      )}
                    </p>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </ScrollArea>
  );
}

/**
 * One project's page: every DAG launched against it, most recent activity first,
 * each with its settlement, its nodes counted, what is driving it, how many
 * surfaces nobody has read, and when it last wrote — every one of them the row
 * the run list serves, and each opening to the run view.
 */
export function ProjectPage({
  projectKey,
  group,
  error,
  loading,
  onSelectRun,
}: {
  readonly projectKey: string;
  readonly group?: ProjectGroup;
  readonly error?: Error;
  readonly loading: boolean;
  readonly onSelectRun: (runId: string) => void;
}) {
  return (
    <ScrollArea className="h-full">
      <section aria-labelledby="project-heading" className="projects-landing">
        <p className="eyebrow">Project</p>
        <h2 id="project-heading">
          {group === undefined ? projectKey : projectLabel(group)}
        </h2>
        {group?.project !== null && group?.project !== undefined && (
          <p className="project-card-id">{group.project}</p>
        )}
        {group && (
          <p className="projects-lede">
            {runCount(group.runs)}
            {group.runs.length > 0 && ` · ${runStateSummary(group.runs)}`}
            {group.last_write_at !== null && (
              <>
                {" · last activity "}
                <Timestamp at={isoOfMillis(group.last_write_at)} relative />
              </>
            )}
          </p>
        )}
        {error && <ReadFailed error={error} what="This project" />}
        {loading ? (
          <div aria-live="polite" className="loading-state">
            <Skeleton className="h-2 w-48" />
            <Skeleton className="h-2 w-32" />
            Loading project…
          </div>
        ) : group ? (
          <ul
            aria-label={`Runs of ${projectLabel(group)}`}
            className="project-runs"
          >
            {group.runs.map((run) => (
              <li key={run.run_id}>
                <ProjectRunRow onSelect={onSelectRun} run={run} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </ScrollArea>
  );
}

function ProjectRunRow({
  run,
  onSelect,
}: {
  readonly run: RunSummary;
  readonly onSelect: (runId: string) => void;
}) {
  const counts = nodeCountSummary(run.node_counts);
  return (
    <button
      aria-label={`Open ${run.run_id}`}
      className="project-run"
      onClick={() => onSelect(run.run_id)}
      type="button"
    >
      <span className="project-run-id">{run.run_id}</span>
      <span className="project-run-facts">
        <StateBadge state={run.state} />
        {/* The engine's own word for how the run is being driven, shown as
            served: a run holding a question is ACTIVE, a run nobody drives is
            UNDRIVEN, and neither is inferred here. */}
        {run.liveness !== undefined && (
          <Badge variant="outline">{run.liveness}</Badge>
        )}
        {run.unread_surfaces !== undefined && run.unread_surfaces > 0 && (
          <Badge variant="secondary">
            {run.unread_surfaces} unread{" "}
            {run.unread_surfaces === 1 ? "surface" : "surfaces"}
          </Badge>
        )}
      </span>
      <span className="project-run-facts project-run-detail">
        {counts && <span>{counts}</span>}
        <span>
          {run.last_progress_at === undefined ? (
            "never written"
          ) : (
            <>
              Last write{" "}
              <Timestamp
                at={isoOfMillis(run.last_progress_at * 1000)}
                relative
              />
            </>
          )}
        </span>
      </span>
    </button>
  );
}

function ReadFailed({
  error,
  what,
}: {
  readonly error: Error;
  readonly what: string;
}) {
  return (
    <Alert className="mb-4" variant="destructive">
      <TriangleAlert />
      <AlertTitle>{what} could not be read</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
