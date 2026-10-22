import { Button, ScrollArea } from "@oneharness/ui";
import type { RunList } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import type { ReactNode } from "react";
import { StructuredFields } from "../../lib/StructuredFields";
import { useHostReads } from "./useHostReads";

/** Host reads are taken on entry and explicit refresh, never stream invalidation. */
export function HostPage({
  client,
  onRefresh,
  list,
  children,
}: {
  readonly client: TelemetryClient;
  readonly onRefresh?: () => void;
  readonly list?: RunList;
  readonly children?: ReactNode;
}) {
  const { host, unwatched, refresh } = useHostReads(client, onRefresh);
  const reading = host.value?.reading;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <section aria-label="Host" className="channel-view host-page">
        <h2>
          This host
          {reading && (
            <>
              {" · "}
              <output aria-label="Host name" className="host-name">
                {reading.host}
              </output>
            </>
          )}
        </h2>
        <Button onClick={refresh}>Refresh host</Button>
        {(host.error || unwatched.error) && (
          <p role="alert">{host.error?.message ?? unwatched.error?.message}</p>
        )}
        {host.loading && <p role="status">Reading host…</p>}
        {reading && (
          <>
            <dl>
              <dt>Runs root</dt>
              <dd>
                <output aria-label="Runs root path">{reading.root}</output>
              </dd>
            </dl>
            {reading.root_error && <p role="alert">{reading.root_error}</p>}
            <section aria-label="Free space">
              <h3>Free space</h3>
              {reading.free_space.map((space, index) => (
                <dl key={space.roots[0]?.path ?? index}>
                  <dt>Filesystem</dt>
                  <dd>
                    {space.roots.map((root, index) => (
                      <span key={root.role}>
                        {index > 0 && " · "}
                        {root.role}:{" "}
                        <output aria-label="Filesystem root path">
                          {root.path ?? "unresolved"}
                        </output>
                        {root.measured_at && (
                          <>
                            {" "}
                            (measured at{" "}
                            <output aria-label="Measured root ancestor">
                              {root.measured_at}
                            </output>
                            )
                          </>
                        )}
                      </span>
                    ))}
                  </dd>
                  <dt>Free bytes</dt>
                  <dd>
                    <output aria-label="Free capacity bytes">
                      {space.free_bytes ?? "Unknown"}
                    </output>
                  </dd>
                  <dt>Total bytes</dt>
                  <dd>
                    <output aria-label="Total capacity bytes">
                      {space.total_bytes ?? "Unknown"}
                    </output>
                  </dd>
                  {space.error && (
                    <>
                      <dt>Error</dt>
                      <dd>{space.error}</dd>
                    </>
                  )}
                </dl>
              ))}
            </section>
            <section aria-label="Providers and dispatches">
              <h3>Providers and dispatches</h3>
              {reading.dispatches.length === 0 ? (
                <p>No live dispatches</p>
              ) : (
                <section
                  aria-label="Providers and dispatches table"
                  className="host-table"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: this box scrolls sideways when a phone's column cannot hold the table, and a keyboard can scroll only what it can focus.
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        {["Run", "Node", "Provider", "Age (ms)", "Proof"].map(
                          (title) => (
                            <th key={title}>{title}</th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {reading.dispatches.map((row) => (
                        <tr key={`${row.run}/${row.node}`}>
                          <td>{row.run}</td>
                          <td>{row.node}</td>
                          <td>{row.launcher}</td>
                          <td>
                            <output
                              aria-label="Dispatch age milliseconds"
                              className="host-age"
                            >
                              {row.age_ms ?? "Unknown"}
                            </output>
                          </td>
                          <td>
                            {row.proof}
                            {row.unproven && `: ${row.unproven}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </section>
            <section aria-label="Gone dispatches">
              <h3>Gone dispatches</h3>
              {reading.gone.map((row) => (
                <p key={`${row.run}/${row.node}`}>
                  {row.run} · {row.node} · {row.reason}
                </p>
              ))}
            </section>
            {reading.skipped.map((row) => (
              <p key={row.path}>
                {row.path}: {row.reason}
              </p>
            ))}
          </>
        )}
        <section aria-label="Unwatched runs">
          <h3>Unwatched runs: {unwatched.value?.reported.length ?? "…"}</h3>
          {unwatched.value?.reported.map((run) => (
            <dl key={run.run}>
              <dt>{run.run}</dt>
              <dd>
                {run.standing} · {run.why_not_watched}
              </dd>
            </dl>
          ))}
          {unwatched.value?.unresolved.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </section>
        <section aria-label="Runs on the host">
          <h3>Runs on the host</h3>
          {list?.runs.map((run) => (
            <p key={run.run_id}>
              {run.run_id} · {run.state}
            </p>
          ))}
        </section>
        <details aria-label="Provider health">
          <summary>Provider health</summary>
          <StructuredFields value={list?.provider_health} />
        </details>
        {children}
      </section>
    </ScrollArea>
  );
}
