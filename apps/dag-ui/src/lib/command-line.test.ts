import { describe, expect, test } from "vitest";
import { argvOf, commandLine } from "./command-line";

describe("commandLine", () => {
  test("leaves plain words bare and quotes an argument holding a space", () => {
    expect(commandLine(["bun", "run", "build", "--name", "a b"])).toBe(
      "bun run build --name 'a b'",
    );
  });

  test("quotes an empty argument so it is still an argument", () => {
    expect(commandLine(["printf", "", "x"])).toBe("printf '' x");
  });

  test("closes, escapes and reopens a single quote, and quotes double quotes", () => {
    expect(commandLine(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
    expect(commandLine(["echo", 'say "hi"'])).toBe(`echo 'say "hi"'`);
  });

  test("quotes what a shell would expand or split", () => {
    expect(commandLine(["sh", "-c", "a && $B; `c`"])).toBe(
      "sh -c 'a && $B; `c`'",
    );
    expect(commandLine(["ls", "*.ts", "~"])).toBe("ls '*.ts' '~'");
    expect(commandLine(["tab\there"])).toBe("'tab\there'");
  });

  test("keeps paths, flags and assignments bare", () => {
    expect(
      commandLine(["/usr/bin/env", "--x=1", "K=v", "a@b:c,d+e%f", "./p/q.r"]),
    ).toBe("/usr/bin/env --x=1 K=v a@b:c,d+e%f ./p/q.r");
  });
});

describe("argvOf", () => {
  test("reads a list of strings as an argv and nothing else", () => {
    expect(argvOf(["a", "b"])).toEqual(["a", "b"]);
    expect(argvOf([])).toBeUndefined();
    expect(argvOf(["a", 1])).toBeUndefined();
    expect(argvOf("a b")).toBeUndefined();
  });
});
