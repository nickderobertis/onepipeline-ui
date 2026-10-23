/** The single fixture writer's surface, for the journeys written in TypeScript. */
export function receiptPath(journal: string): string;
export function receiptFor(journal: string): void;
export function appendRecords(
  journal: string,
  records: readonly Record<string, unknown>[],
): void;
export function appendLines(journal: string, lines: readonly string[]): void;
