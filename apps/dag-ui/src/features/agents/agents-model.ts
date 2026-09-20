import {
  AGENT_LABEL_PREFIX,
  AGENT_LABELS,
  AGENT_SCOPES,
  type AgentScope,
  type AgentSession,
} from "@onepipeline-ui/dag-model";

/**
 * One group of a listing: the sessions one launch of a run wrote — a scope, and
 * under `node` and `pr-author` the attempt they belong to.
 *
 * A session the engine stamped no scope on, or a word this build has never
 * seen, is grouped under its own word rather than dropped: the label is the
 * engine's and released on its own schedule, and a session a reader cannot
 * find is worse than one under an unfamiliar heading.
 */
export interface AgentGroup {
  readonly scope: string;
  /** The attempt, where the scope carries one; absent for the observer. */
  readonly attempt?: string;
  readonly sessions: readonly AgentSession[];
}

/** The word each scope the engine declares is read under. */
const SCOPE_LABELS: Readonly<Record<AgentScope, string>> = {
  node: "Node dispatch",
  observer: "Observer",
  "pr-author": "Change request author",
};

/** Whether a stamped scope word is one the engine declares. */
function isAgentScope(scope: string): scope is AgentScope {
  return AGENT_SCOPES.some((known) => known === scope);
}

/** The word a scope is read under: its own, where this build has none for it. */
export function scopeLabel(scope: string): string {
  return isAgentScope(scope) ? SCOPE_LABELS[scope] : scope;
}

/** The heading one group is read under: its scope, and its attempt where it has one. */
export function groupLabel(group: AgentGroup): string {
  return group.attempt === undefined
    ? scopeLabel(group.scope)
    : `${scopeLabel(group.scope)} · attempt ${group.attempt}`;
}

/**
 * The sessions grouped by scope and attempt, in the order a reader scans them:
 * the engine's scopes in their own order, then any word it never declared, and
 * within a scope the attempts ascending. Sessions keep the order the server
 * served them in — the order each first appeared.
 */
export function groupAgentSessions(
  sessions: readonly AgentSession[],
): readonly AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const session of sessions) {
    const scope = session.labels[AGENT_LABELS.scope] ?? "unscoped";
    const attempt = session.labels[AGENT_LABELS.attempt];
    // A scope word never carries a space, so the pair cannot spell another pair.
    const key = `${scope} ${attempt ?? ""}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { scope, attempt, sessions: [session] });
    } else {
      groups.set(key, { ...group, sessions: [...group.sessions, session] });
    }
  }
  const rank = (scope: string): number =>
    isAgentScope(scope) ? AGENT_SCOPES.indexOf(scope) : AGENT_SCOPES.length;
  return [...groups.values()].sort(
    (a, b) =>
      rank(a.scope) - rank(b.scope) ||
      a.scope.localeCompare(b.scope) ||
      Number(a.attempt ?? 0) - Number(b.attempt ?? 0),
  );
}

/**
 * The facts a reader wants beside a session: the node and the step the engine
 * stamped, then every label the repository stamped beside the engine's — a
 * `role`, an `owner` — under the words it chose. The engine's remaining keys
 * (the run, the project, the scope and the attempt) are what the listing and
 * the group already say.
 */
export function sessionFacts(
  session: AgentSession,
): readonly (readonly [string, string])[] {
  const facts: [string, string][] = [];
  const node = session.labels[AGENT_LABELS.node];
  if (node !== undefined) facts.push(["node", node]);
  const step = session.labels[AGENT_LABELS.step];
  if (step !== undefined) facts.push(["step", step]);
  for (const [key, value] of Object.entries(session.labels)) {
    if (!key.startsWith(AGENT_LABEL_PREFIX)) facts.push([key, value]);
  }
  return facts;
}

/** How a count of sessions is said. */
export function agentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"}`;
}
