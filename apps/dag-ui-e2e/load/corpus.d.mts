/** The load corpus's surface, for the harness written in TypeScript. */
export interface LoadCorpus {
  readonly runs: number;
  readonly projects: number;
  readonly openLiveRun: string;
  readonly openLiveRecords: number;
  readonly settledRun: string;
  readonly stoppedRun: string;
  readonly otherLiveRuns: readonly string[];
  readonly liveNode: string;
  readonly openProject: string;
}
export const OPEN_LIVE_RUN: string;
export const SETTLED_OPEN_RUN: string;
export const STOPPED_OPEN_RUN: string;
export const OTHER_LIVE_RUNS: readonly string[];
export const LIVE_NODE: string;
export const OTHER_LIVE_NODE: string;
export const PROJECTS: number;
export const RUNS: number;
export const OPEN_LIVE_RECORDS: number;
export function projectOf(index: number): string;
export function streamOf(runId: string): string;
export function buildLoadCorpus(
  root: string,
  scale?: "host" | "journey",
): LoadCorpus;
