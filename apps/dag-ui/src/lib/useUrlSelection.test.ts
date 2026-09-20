import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useUrlSelection } from "./useUrlSelection";

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(cleanup);

test("reads the selection from the query string", () => {
  window.history.replaceState(
    null,
    "",
    "/?run=run-1&node=build&view=overall&event=event-7",
  );
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.runId).toBe("run-1");
  expect(result.current.nodeId).toBe("build");
  expect(result.current.itemId).toBe("event-7");
  expect(result.current.view).toBe("overall");
});

test("lands on the overall view when the address names none", () => {
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.view).toBe("overall");
});

test("opens the node a bookmark names, whether or not it names a view", () => {
  window.history.replaceState(null, "", "/?run=run-1&node=build");
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.nodeId).toBe("build");
  expect(result.current.view).toBe("graph");
});

test("carries the opened moment of a node's execution", () => {
  window.history.replaceState(null, "", "/?run=run-1&node=build");
  const { result } = renderHook(() => useUrlSelection());
  act(() => result.current.selectItem("dispatch-worker"));
  expect(window.location.search).toContain("event=dispatch-worker");
  expect(result.current.itemId).toBe("dispatch-worker");
  act(() => result.current.selectItem(undefined));
  expect(result.current.itemId).toBeUndefined();
  // Another node recorded different work, so the moment cannot survive the move.
  act(() => result.current.selectItem("dispatch-worker"));
  act(() => result.current.selectNode("ship"));
  expect(result.current.itemId).toBeUndefined();
  expect(result.current.nodeId).toBe("ship");
});

test("defaults, deep-links, and clears the selected node tab", () => {
  window.history.replaceState(null, "", "/?run=run-1&node=build&tab=checks");
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.nodeTab).toBe("checks");
  act(() => result.current.selectNodeTab("task"));
  expect(result.current.nodeTab).toBe("task");
  expect(window.location.search).toContain("tab=task");
  act(() => result.current.selectNodeTab("timeline"));
  expect(result.current.nodeTab).toBe("timeline");
  expect(window.location.search).not.toContain("tab=");
});

test("selecting a run clears the node and keeps the reading", () => {
  window.history.replaceState(null, "", "/?run=run-1&node=build&view=overall");
  const { result } = renderHook(() => useUrlSelection());
  act(() => result.current.selectRun("run-2"));
  expect(result.current.runId).toBe("run-2");
  expect(result.current.nodeId).toBeUndefined();
  // A reader comparing two runs on the overall view stays on it; only the node,
  // which belonged to the run being left, cannot survive the move.
  expect(result.current.view).toBe("overall");
});

test("selecting and clearing a node moves back to the graph view", () => {
  const { result } = renderHook(() => useUrlSelection());
  act(() => result.current.showOverall());
  expect(result.current.view).toBe("overall");
  act(() => result.current.selectNode("build"));
  expect(result.current.nodeId).toBe("build");
  expect(result.current.view).toBe("graph");
  act(() => result.current.selectNode(undefined));
  expect(result.current.nodeId).toBeUndefined();
  // Leaving a node is a walk back to the graph it sits in, not to the landing view.
  expect(result.current.view).toBe("graph");
});

test("follows a history navigation the browser performs itself", () => {
  const { result } = renderHook(() => useUrlSelection());
  act(() => result.current.selectRun("run-2"));
  expect(result.current.runId).toBe("run-2");
  act(() => {
    // What the browser does for a back button: change the URL, then announce it.
    window.history.replaceState(null, "", "/?run=run-1&node=build");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(result.current.runId).toBe("run-1");
  expect(result.current.nodeId).toBe("build");
});

test("opens on the projects, and carries the project a page or a run was reached through", () => {
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.list).toBe("projects");
  expect(result.current.projectKey).toBeUndefined();
  act(() => result.current.selectProject("local-md:observatory"));
  expect(window.location.search).toBe("?project=local-md%3Aobservatory");
  expect(result.current.projectKey).toBe("local-md:observatory");
  // A run opened from the page keeps the page one step back.
  act(() => result.current.selectRun("run-1"));
  expect(result.current.projectKey).toBe("local-md:observatory");
  expect(result.current.runId).toBe("run-1");
  // And opening a project closes the run and everything under it.
  act(() => result.current.selectNode("build"));
  act(() => result.current.selectProject("none"));
  expect(result.current.runId).toBeUndefined();
  expect(result.current.nodeId).toBeUndefined();
  expect(result.current.projectKey).toBe("none");
  // The reading survives, as it does across runs: the graph a reader was on is
  // the graph the next run opens on.
  act(() => result.current.selectProject(undefined));
  expect(window.location.search).toBe("?view=graph");
});

test("keeps the flat run list one toggle away, and reads an unknown list as the projects", () => {
  window.history.replaceState(null, "", "/?list=everything&run=run-1");
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.list).toBe("projects");
  act(() => result.current.selectList("runs"));
  expect(result.current.list).toBe("runs");
  expect(window.location.search).toContain("list=runs");
  // The run on screen stays on screen across the toggle.
  expect(result.current.runId).toBe("run-1");
  act(() => result.current.selectProject("local-md:observatory"));
  expect(result.current.list).toBe("projects");
  act(() => result.current.selectList("runs"));
  expect(result.current.projectKey).toBeUndefined();
  act(() => result.current.selectList("projects"));
  expect(window.location.search).not.toContain("list=");
});

test("opens a supervising reading of the run, closing the node under it", () => {
  window.history.replaceState(null, "", "/?run=run-1&node=build&event=e-1");
  const { result } = renderHook(() => useUrlSelection());
  act(() => result.current.selectView("channel"));
  expect(result.current.view).toBe("channel");
  expect(result.current.nodeId).toBeUndefined();
  expect(result.current.itemId).toBeUndefined();
  expect(window.location.search).toBe("?run=run-1&view=channel");
});

test("reads a view the app has no reading for as an unnamed one", () => {
  window.history.replaceState(null, "", "/?run=run-1&view=launch");
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.view).toBe("overall");
});

test("reads a project key that is neither the reserved word nor a qualified id as none", () => {
  window.history.replaceState(null, "", "/?project=not%20a%20project");
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.projectKey).toBeUndefined();
  window.history.replaceState(null, "", "/?project=local-md%3Aobservatory");
  const { result: named } = renderHook(() => useUrlSelection());
  expect(named.current.projectKey).toBe("local-md:observatory");
});

test("reads a run, node or item the API could never serve as unnamed", () => {
  window.history.replaceState(
    null,
    "",
    "/?run=a%2Fb&node=build%3Fx&event=bad%23id",
  );
  const { result } = renderHook(() => useUrlSelection());
  expect(result.current.runId).toBeUndefined();
  expect(result.current.nodeId).toBeUndefined();
  expect(result.current.itemId).toBeUndefined();
});
