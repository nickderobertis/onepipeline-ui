// THROWAWAY visual spike for the project-centric navigation and timeline rework.
// Static mock data only; rendered instead of the app when the URL carries
// `?spike=<view>`. Nothing here is wired to the read API. Not for landing.
import {
  Badge,
  Button,
  cn,
  ScrollArea,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  TooltipProvider,
} from "@oneharness/ui";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CloudCog,
  FolderKanban,
  Inbox,
  Power,
  RefreshCw,
  Route,
  Satellite,
  Server,
  Square,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";

type View =
  | "sidebar"
  | "host"
  | "header"
  | "nodelist"
  | "timeline"
  | "remote"
  | "channel";

const KINDS = [
  "main",
  "planning",
  "spikes",
  "finalize",
  "design",
  "follow-ups",
] as const;

const PROJECTS = [
  {
    name: "dag-ui-project-centric",
    id: "authoring:dag-ui-project-centric",
    summary: "6 runs · 2 active · 4 settled",
    when: "in 18 seconds",
    runs: [
      { id: "dag-ui-live", kind: "main", state: "active", dot: "bg-primary" },
      {
        id: "dag-ui-plan-r2",
        kind: "planning",
        state: "settled",
        dot: "bg-success",
      },
      {
        id: "dag-ui-spike-visual",
        kind: "spikes",
        state: "active",
        dot: "bg-primary",
      },
      {
        id: "dag-ui-named",
        kind: "design",
        state: "settled",
        dot: "bg-success",
      },
      {
        id: "dag-ui-finalize",
        kind: "finalize",
        state: "settled",
        dot: "bg-success",
      },
      {
        id: "dag-ui-followups-1",
        kind: "follow-ups",
        state: "settled",
        dot: "bg-success",
      },
    ],
  },
  {
    name: "supervised",
    id: "local-md:supervision",
    summary: "2 runs · 2 active",
    when: "10 minutes ago",
    runs: [],
  },
  {
    name: "archive",
    id: "local-md:archive",
    summary: "3 runs · 1 settled · 2 active",
    when: "2 months ago",
    runs: [],
  },
  {
    name: "(no project)",
    id: "adoptable",
    summary: "43 runs · 1 paused · 42 active",
    when: "12 minutes ago",
    runs: [],
  },
];

function Sidebar({
  selectedRun,
  host,
}: {
  readonly selectedRun?: string;
  readonly host?: boolean;
}) {
  return (
    <nav aria-label="Projects" className="run-nav">
      <ScrollArea className="h-full">
        <div className="px-[18px] py-6">
          <div className="brand">
            <div aria-hidden="true" className="brand-mark">
              <Activity size={20} />
            </div>
            <div>
              <p className="eyebrow">Local orchestration</p>
              <h1>DAG Observatory</h1>
            </div>
          </div>
          <Separator className="my-[22px]" />
          <button
            className="run-link"
            data-active={host === true}
            type="button"
          >
            <span className="run-link-main">
              <Server aria-hidden="true" size={13} />
              <span>This host</span>
            </span>
            <ChevronRight aria-hidden="true" size={14} />
            <span className="run-link-counts">
              51 runs · 3 unwatched · 4 owners
            </span>
          </button>
          <div className="mt-4 mb-2 flex items-center justify-between">
            <p className="eyebrow m-0">Projects</p>
          </div>
          <fieldset className="mb-3 flex flex-wrap gap-1 border-0 p-0">
            <legend className="sr-only">Run kinds</legend>
            {["all", ...KINDS].map((kind) => (
              <button
                aria-pressed={kind === "all"}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px]",
                  kind === "all"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground",
                )}
                key={kind}
                style={{ fontSize: 10, lineHeight: "16px" }}
                type="button"
              >
                {kind}
              </button>
            ))}
          </fieldset>
          <ul className="run-list project-rows m-0 list-none p-0">
            {PROJECTS.map((project, index) => (
              <li key={project.id}>
                <button className="run-link" type="button">
                  <span className="run-link-main">
                    <FolderKanban aria-hidden="true" size={13} />
                    <span>{project.name}</span>
                  </span>
                  {index === 0 ? (
                    <ChevronDown aria-hidden="true" size={14} />
                  ) : (
                    <ChevronRight aria-hidden="true" size={14} />
                  )}
                  <span className="run-link-counts">
                    {project.summary} · {project.when}
                  </span>
                </button>
                {index === 0 && (
                  <ul className="m-0 mb-2 ml-3 list-none border-l border-border p-0 pl-2">
                    {project.runs.map((run) => (
                      <li key={run.id}>
                        <button
                          className="run-link my-0.5 py-1.5"
                          style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
                          data-active={run.id === selectedRun}
                          type="button"
                        >
                          <span className="run-link-main">
                            <span
                              className={cn(
                                "inline-block size-2 shrink-0 rounded-full",
                                run.dot,
                              )}
                            />
                            <span>{run.id}</span>
                            <span
                              className="ml-auto shrink-0 rounded border border-border px-1 text-muted-foreground"
                              style={{ fontSize: 9, lineHeight: "14px" }}
                            >
                              {run.kind}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </ScrollArea>
    </nav>
  );
}

function Topbar({
  title,
  run,
  state = "ACTIVE",
  activity = "Last activity 4s ago · dashboard: tool Bash cargo nextest run --locked -E 'binary(e2e)' --status-level fail --no-fail-fast",
}: {
  readonly activity?: string;
  readonly title: string;
  readonly run?: boolean;
  readonly state?: string;
}) {
  return (
    <header className="topbar gap-6">
      <div className="topbar-title min-w-0 flex-1">
        <div className="min-w-0">
          <p className="eyebrow">
            {run
              ? `dag-ui-project-centric · ${title === "dag-ui-named" ? "design" : "main"} run`
              : "Execution telemetry"}
          </p>
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="shrink-0">{title}</h2>
            {run && (
              <>
                <Badge variant="outline">{state}</Badge>
                <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                  {activity}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="topbar-actions shrink-0">
        {run && state !== "SETTLED" && (
          <Button size="sm" type="button" variant="destructive">
            <Square size={13} /> Stop
          </Button>
        )}
        <span className="connection">
          <Satellite size={15} /> Updated 0s ago
        </span>
        <Button size="sm" type="button" variant="outline">
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
    </header>
  );
}

function RunTabs({ value }: { readonly value: string }) {
  return (
    <Tabs className="gap-0" value={value}>
      <div className="view-tabs">
        <TabsList aria-label="DAG views" variant="line">
          <TabsTrigger value="graph">
            <Workflow size={15} /> Graph
          </TabsTrigger>
          <TabsTrigger value="overall">
            <Route size={15} /> Overall
          </TabsTrigger>
          <TabsTrigger value="channel">
            <Inbox size={15} /> Channel
          </TabsTrigger>
        </TabsList>
        <fieldset className="detail-switch">
          <Button size="sm" type="button" variant="outline">
            Decisions
          </Button>
          <Button size="sm" type="button" variant="default">
            Detailed activity
          </Button>
        </fieldset>
      </div>
    </Tabs>
  );
}

function Shell({
  children,
  title,
  run,
  tab,
  host,
  state,
  activity,
}: {
  readonly children: ReactNode;
  readonly title: string;
  readonly run?: boolean;
  readonly tab?: string;
  readonly host?: boolean;
  readonly state?: string;
  readonly activity?: string;
}) {
  return (
    <TooltipProvider>
      <div className="app-shell">
        <Sidebar host={host} selectedRun={run ? title : undefined} />
        <main className="workspace">
          <Topbar activity={activity} run={run} state={state} title={title} />
          {tab !== undefined && <RunTabs value={tab} />}
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </main>
      </div>
    </TooltipProvider>
  );
}

function Card({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      className={cn("rounded-2xl border border-border bg-card p-5", className)}
    >
      {children}
    </section>
  );
}

function SidebarView() {
  return (
    <Shell title="dag-ui-project-centric">
      <div className="p-7">
        <p className="eyebrow">Project</p>
        <h3 className="mb-1 font-mono text-[22px]">dag-ui-project-centric</h3>
        <p className="mb-5 text-[13px] text-muted-foreground">
          authoring:dag-ui-project-centric · 6 runs · 2 active · 4 settled
        </p>
        <div className="grid gap-2">
          {PROJECTS[0]?.runs.map((run) => (
            <Card className="flex items-center gap-4 py-3" key={run.id}>
              <span className={cn("size-2 rounded-full", run.dot)} />
              <span className="font-mono text-[13px]">{run.id}</span>
              <Badge variant="outline">{run.kind}</Badge>
              <span className="ml-auto text-[12px] text-muted-foreground">
                {run.state}
              </span>
            </Card>
          ))}
        </div>
      </div>
    </Shell>
  );
}

function HostView() {
  const stats = [
    ["Runs", "51"],
    ["Active", "46"],
    ["Unwatched", "3"],
    ["Agents running", "9"],
    ["Owners", "4"],
  ];
  return (
    <Shell host title="This host">
      <div className="relative p-7">
        <p className="eyebrow">Host</p>
        <h3 className="mb-5 font-mono text-[22px]">nick-dev-01</h3>
        <div className="mb-5 grid grid-cols-5 gap-3">
          {stats.map(([label, value]) => (
            <Card key={label}>
              <p className="eyebrow">{label}</p>
              <p
                className={cn(
                  "m-0 text-[22px]",
                  label === "Unwatched" && "text-warning",
                )}
              >
                {value}
              </p>
            </Card>
          ))}
        </div>
        <Card className="mb-5">
          <p className="eyebrow">Unwatched runs</p>
          {[
            ["dag-ui-live", "dag-ui-project-centric", "no watcher for 4m"],
            ["dag-ui-elsewhere", "supervised", "no watcher for 11m"],
            ["dag-ui-busy", "archive", "no watcher for 2h"],
          ].map(([run, project, why]) => (
            <div
              className="flex gap-4 border-t border-border py-2 text-[13px]"
              key={run}
            >
              <span className="font-mono">{run}</span>
              <span className="text-muted-foreground">{project}</span>
              <span className="ml-auto text-muted-foreground">{why}</span>
            </div>
          ))}
        </Card>
        <Card className="flex items-center justify-between">
          <div>
            <p className="eyebrow">Shutdown</p>
            <p className="m-0 text-[13px] text-muted-foreground">
              Stops every run and agent on this host, whoever owns it.
            </p>
          </div>
          <Button type="button" variant="destructive">
            <Power size={14} /> Shut down this host
          </Button>
        </Card>
        {/* the confirmation, shown open */}
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/55">
          <div
            aria-label="Shut down this host?"
            className="w-[520px] rounded-2xl border border-border bg-popover p-6 shadow-2xl"
            role="dialog"
          >
            <h3 className="mb-2 text-[17px]">Shut down this host?</h3>
            <p className="text-[13px] text-muted-foreground">
              This stops 46 active runs and 9 agents belonging to 4 owners:
            </p>
            <ul className="mb-4 text-[13px]">
              <li>
                <b>you</b> (session 33ff8f3b) — 6 runs
              </li>
              <li>
                <b>manager c1fa3f33</b> — 38 runs
              </li>
              <li>
                <b>manager 27c79d42</b> — 1 run
              </li>
              <li>
                <b>no owner</b> (adoptable) — 1 run
              </li>
            </ul>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline">
                Cancel
              </Button>
              <Button type="button" variant="destructive">
                <Power size={14} /> Shut down 46 runs
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

type Bar = readonly [number, number, string];

const LIVE_BARS: readonly Bar[] = [
  [0, 6, "#9a7bd0"],
  [6, 17, "#e08a4f"],
  [17, 33, "#6f95dd"],
  [33, 39, "#9a7bd0"],
  [39, 58, "#6f95dd"],
  [58, 64, "#e08a4f"],
  [64, 81, "#6f95dd"],
  [81, 100, "#e08a4f"],
];

// dag-ui-named: 17s, settled at +17s; idle only between work, none after.
const NAMED_BARS: readonly Bar[] = [
  [0, 1, "#8a86d6"],
  [1, 2, "#5fb87a"],
  [2, 11, "idle"],
  [11, 14, "#d4a73c"],
  [14, 15, "idle"],
  [15, 17, "#e08a4f"],
];

function VisualTimeline({ settled }: { readonly settled?: boolean }) {
  const bars = settled ? NAMED_BARS : LIVE_BARS;
  const end = settled ? 17 : 100;
  const ticks = settled
    ? Array.from({ length: 18 }, (_, i) => [i / 17, `+${i}s`] as const)
    : Array.from(
        { length: 14 },
        (_, i) => [i / 13, `+${(i * 15) / 60 < 1 ? `${i * 15}s` : `${Math.floor((i * 15) / 60)}m${(i * 15) % 60 ? ` ${(i * 15) % 60}s` : ""}`}`] as const,
      );
  const cursor = settled ? 7.5 / 17 : 0.54;
  const legend = settled
    ? [
        ["#8a86d6", "ticker"],
        ["#5fb87a", "sentinel"],
        ["#d4a73c", "reviser"],
        ["#e08a4f", "drafter"],
      ]
    : [
        ["#9a7bd0", "Queued"],
        ["#e08a4f", "check-in"],
        ["#6f95dd", "worker"],
      ];
  return (
    <Card className="mt-5">
      <div className="mb-3 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="eyebrow m-0">Graph timeline</span>
        {legend.map(([color, label]) => (
          <span className="flex items-center gap-1" key={label}>
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: color }}
            />
            {label}
          </span>
        ))}
        <span className="ml-auto">
          {settled
            ? "Started 09:00:00 · settled 09:00:17 · ran 17s"
            : "Started 08:57:00 · running 3m 18s"}
        </span>
      </div>
      <div className="relative rounded-xl border border-border px-4 pt-7 pb-3">
        <div className="relative h-5">
          {bars.map(([from, to, color]) => (
            <div
              className="absolute top-0 h-5 rounded-full"
              key={from}
              style={{
                left: `${(from / end) * 100}%`,
                width: `calc(${((to - from) / end) * 100}% - 3px)`,
                background:
                  color === "idle"
                    ? "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, currentColor 30%, transparent) 4px 6px)"
                    : color,
                border: color === "idle" ? "1px solid var(--border)" : undefined,
              }}
            />
          ))}
          {settled && (
            <>
              <div
                className="absolute -top-5 -bottom-1 w-0.5 bg-success"
                style={{ left: "calc(100% - 2px)" }}
              />
              <span className="absolute -top-6 right-2 text-[10px] text-success">
                settled +17s
              </span>
            </>
          )}
        </div>
        <div className="relative mt-1 h-9">
          {ticks.map(([at, label], index) => (
            <span
              className="absolute -translate-x-1/2 text-center font-mono text-[9px] text-muted-foreground"
              key={label}
              style={{ left: `${at * 100}%` }}
            >
              <span className="mx-auto mb-0.5 block h-1.5 w-px bg-muted-foreground/60" />
              {label}
              {index % (settled ? 5 : 4) === 0 && (
                <span className="block text-foreground/70">
                  {settled
                    ? `09:00:${String(index).padStart(2, "0")}`
                    : (() => {
                        const t = 8 * 3600 + 57 * 60 + index * 15;
                        const pad = (n: number) => String(n).padStart(2, "0");
                        return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
                      })()}
                </span>
              )}
            </span>
          ))}
        </div>
        {/* hover crosshair */}
        <div
          className="pointer-events-none absolute top-1 bottom-1 w-px bg-foreground/80"
          style={{ left: `calc(16px + (100% - 32px) * ${cursor})` }}
        >
          <div className="absolute top-0 left-2 rounded-md border border-border bg-popover px-2 py-1 font-mono text-[11px] whitespace-nowrap shadow-lg">
            {settled ? "09:00:07.5 · elapsed 7.5s" : "08:58:47 · elapsed 1m 47s"}
          </div>
        </div>
      </div>
    </Card>
  );
}

function HeaderView() {
  return (
    <Shell run tab="overall" title="dag-ui-live">
      <div className="p-7">
        <Card>
          <p className="eyebrow">Whole DAG</p>
          <h3 className="mb-2 font-mono text-[22px]">dag-ui-live</h3>
          <p className="m-0 text-[14px]">Observe the live DAG safely</p>
        </Card>
        <div className="mt-4 grid grid-cols-4 gap-3">
          {[
            ["Status", "active"],
            ["Nodes", "11"],
            ["Wall time", "3m 18s"],
            ["Turns", "12"],
          ].map(([label, value]) => (
            <Card key={label}>
              <p className="eyebrow">{label}</p>
              <p className="m-0 text-[16px]">{value}</p>
            </Card>
          ))}
        </div>
        <VisualTimeline />
      </div>
    </Shell>
  );
}

function TimelineView() {
  return (
    <Shell
      activity="Settled 2 months ago · last event node-settled"
      run
      state="SETTLED"
      tab="overall"
      title="dag-ui-named"
    >
      <div className="p-7">
        <Card className="mb-4">
          <p className="eyebrow">Whole DAG</p>
          <h3 className="mb-2 font-mono text-[22px]">dag-ui-named</h3>
          <p className="m-0 text-[14px]">Name the members</p>
        </Card>
        <div className="grid grid-cols-4 gap-3">
          {[
            ["Status", "settled"],
            ["Nodes", "2"],
            ["Wall time", "17s"],
            ["Turns", "5"],
          ].map(([label, value]) => (
            <Card key={label}>
              <p className="eyebrow">{label}</p>
              <p className="m-0 text-[16px]">{value}</p>
            </Card>
          ))}
        </div>
        <VisualTimeline settled />
      </div>
    </Shell>
  );
}

function NodeHead({
  tab,
  node = "dashboard",
  facts = "agent node · 9 turns · 3 lint turns",
  status = "RUNNING",
}: {
  readonly tab: string;
  readonly node?: string;
  readonly facts?: string;
  readonly status?: string;
}) {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-7 py-3 text-[13px]">
        <span className="text-muted-foreground">Graph /</span>
        <span className="font-mono">{node}</span>
        <Badge className="ml-auto" variant="outline">
          {status}
        </Badge>
        <span className="text-[12px] text-muted-foreground">{facts}</span>
      </div>
      <Tabs className="gap-0" value={tab}>
        <div className="border-b border-border px-6 py-1">
          <TabsList aria-label="Node views" variant="line">
            {[
              ["timeline", "Timeline"],
              ["task", "Task"],
              ["criteria", "Acceptance criteria"],
              ["dependencies", "Dependencies"],
              ["remote", "Remote"],
            ].map(([value, label]) => (
              <TabsTrigger key={value} value={value ?? ""}>
                {value === "remote" && <CloudCog size={14} />}
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
    </>
  );
}

const GROUPS: readonly {
  title: string;
  who: string;
  rows: readonly (readonly [string, string, string, string?])[];
}[] = [
  {
    title: "Dispatch 1 · worker (engineer-dashboard)",
    who: "08:58:34 → 09:00:07 · settled done",
    rows: [
      ["08:58:34", "dispatch", "worker dispatched · attempt 1"],
      ["08:58:39", "turn", "turn 1 started"],
      ["08:58:40", "tool", "Read apps/dag-ui/src/app/App.tsx", "0.1s"],
      ["08:58:41", "tool", "Grep 'RunNavigation' apps/dag-ui/src", "0.2s"],
      ["08:58:44", "tool", "Edit apps/dag-ui/src/features/navigation/…", "0.1s"],
      [
        "08:58:49",
        "tool",
        "Bash cargo nextest run --locked -E 'binary(e2e)' --status-level fail",
        "41.3s",
      ],
      ["08:59:30", "turn", "turn 2 started"],
      ["08:59:31", "tool", "Bash git add -A && git commit -m 'feat: …'", "1.4s"],
      ["08:59:40", "judge", "judge · you-are-a-strict-careful-evaluator · pass"],
      ["09:00:04", "redirect", "Redirected into the running turn"],
    ],
  },
  {
    title: "Dispatch 2 · check-in",
    who: "09:00:07 → 09:00:12 · settled done",
    rows: [
      ["09:00:07", "dispatch", "check-in dispatched"],
      ["09:00:09", "tool", "Bash onevcs change show s-ec03908ab90a", "0.8s"],
    ],
  },
  {
    title: "Change-request drafter",
    who: "09:00:12 → 09:00:31 · settled done",
    rows: [
      ["09:00:12", "dispatch", "drafter dispatched"],
      ["09:00:14", "tool", "Bash git log --oneline origin/main..HEAD", "0.2s"],
      ["09:00:18", "tool", "Write /tmp/pr-body.md", "0.1s"],
      ["09:00:29", "tool", "Bash onevcs change describe --body-file …", "1.1s"],
    ],
  },
];

function NodeListView() {
  return (
    <Shell run tab="graph" title="dag-ui-live">
      <NodeHead tab="timeline" />
      <div className="grid gap-3 p-6">
        {GROUPS.map((group) => (
          <section
            className="rounded-xl border border-border bg-card"
            key={group.title}
          >
            <header className="flex items-center gap-3 border-b border-border px-4 py-2">
              <ChevronDown size={14} />
              <span className="text-[13px] font-medium">{group.title}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {group.who}
              </span>
            </header>
            <ol className="m-0 list-none p-0">
              {group.rows.map(([at, kind, text, took]) => (
                <li
                  className="grid grid-cols-[64px_72px_minmax(0,1fr)_56px] items-center gap-3 border-b border-border/40 px-4 py-1 text-[12px] last:border-0"
                  key={`${at}${text}`}
                >
                  <span className="font-mono text-muted-foreground">{at}</span>
                  <span className="eyebrow m-0">{kind}</span>
                  <span className="truncate font-mono">{text}</span>
                  <span className="text-right text-muted-foreground">
                    {took ?? ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </Shell>
  );
}

function RemoteView() {
  const checks = [
    ["gate", "required", "completed", "success", "1s"],
    ["e2e", "required", "in progress", "—", "4s · running"],
    ["published-smoke", "advisory", "completed", "failure", "2s"],
  ];
  return (
    <Shell run tab="graph" title="dag-ui-live">
      <NodeHead
        facts="agent node · 0 turns · 0 lint turns"
        node="remote-open"
        status="DONE"
        tab="remote"
      />
      <div className="p-6">
        <Card>
          <div className="mb-3 flex items-center gap-3 text-[13px]">
            <span className="eyebrow m-0">Change request</span>
            <span className="font-mono">#412</span>
            <span className="text-muted-foreground">open · hook present · 1 of 2 required green</span>
          </div>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                {["Check", "Status", "Conclusion", "Runtime"].map((h) => (
                  <th
                    className="eyebrow border-b border-border py-2 font-bold"
                    key={h}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {checks.map(([name, req, status, conclusion, runtime]) => (
                <tr className="border-b border-border/50" key={name}>
                  <td className="py-2 font-mono">
                    {name}{" "}
                    <span className="text-[10px] text-muted-foreground">
                      {req}
                    </span>
                  </td>
                  <td>{status}</td>
                  <td
                    className={cn(
                      conclusion === "success" && "text-success",
                      conclusion === "failure" && "text-destructive",
                    )}
                  >
                    {conclusion}
                  </td>
                  <td className="font-mono">{runtime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </Shell>
  );
}

function ChannelView() {
  const pairs = [
    [
      "09:00:41",
      "dashboard",
      "Should the kind filter persist across reloads?",
      "Yes — keep it in the URL like the detail level.",
    ],
    [
      "08:59:12",
      "foundation",
      "Gate failed on a flaky Windows journey; retry or investigate?",
      "Retry once, then investigate.",
    ],
    [
      "08:58:03",
      "remote-open",
      "Two required checks are still queued after 20m. Keep waiting?",
      "Keep waiting; the runners are backed up.",
    ],
    [
      "08:57:30",
      "planner",
      "Split the timeline work into two nodes?",
      "(no reply yet)",
    ],
  ];
  return (
    <Shell run tab="channel" title="dag-ui-live">
      <div className="p-6">
        <div className="mb-3 flex items-center gap-2">
          <Inbox size={15} />
          <span className="eyebrow m-0">Questions and replies</span>
        </div>
        <div className="rounded-xl border border-border bg-card">
          {pairs.map(([at, node, question, reply], index) => (
            <div className="border-b border-border/60 last:border-0" key={at}>
              <div className="grid grid-cols-[16px_64px_96px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 px-4 py-2 text-[12px]">
                {index === 1 ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                <span className="font-mono text-muted-foreground">{at}</span>
                <span className="font-mono">{node}</span>
                <span className="truncate">Q: {question}</span>
                <span
                  className={cn(
                    "truncate",
                    reply?.startsWith("(")
                      ? "text-warning"
                      : "text-muted-foreground",
                  )}
                >
                  ↳ {reply}
                </span>
              </div>
              {index === 1 && (
                <div className="grid gap-3 px-11 pb-4 text-[13px]">
                  <div className="rounded-lg border border-border p-3">
                    <p className="eyebrow">Question · foundation · 08:59:12</p>
                    <p className="m-0">
                      The gate failed on `ui::navigation` under test-windows
                      with a 5s timeout; it passed on the previous two pushes.
                      Retry the job or investigate the journey first?
                    </p>
                  </div>
                  <div className="rounded-lg border border-primary/50 p-3">
                    <p className="eyebrow">Reply · you · 08:59:40</p>
                    <p className="m-0">
                      Retry once, then investigate if it fails again.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

export function SpikeMock({ view }: { readonly view: string }) {
  const views: Record<View, () => ReactNode> = {
    sidebar: SidebarView,
    host: HostView,
    header: HeaderView,
    nodelist: NodeListView,
    timeline: TimelineView,
    remote: RemoteView,
    channel: ChannelView,
  };
  const render = views[view as View] ?? SidebarView;
  return <>{render()}</>;
}
