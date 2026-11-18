/**
 * One argv as one shell-quoted command line: `bun run build --flag 'a b'`.
 *
 * The engine runs a command step's argv itself, with no shell, so nothing a
 * reader sees was ever a command line; this is the one way the app writes it as
 * one, so the row that started it, the row's detail and the command node's own
 * header read the same. An argument a POSIX shell would read as itself is left
 * bare; every other one is single-quoted, a single quote inside it closed,
 * escaped and reopened (`'it'\''s'`), and an empty argument is `''` so it is
 * still an argument.
 */
export function commandLine(argv: readonly string[]): string {
  return argv.map(quoted).join(" ");
}

const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/u;

function quoted(argument: string): string {
  if (argument === "") return "''";
  if (BARE.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** The argv a record's value is, where it is one: a list of strings and nothing else. */
export function argvOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string")
    ? value
    : undefined;
}
