import { describe, expect, it } from "vitest";

import { readApiTarget } from "./api-target";

describe("the read API a browser's proxy is pointed at", () => {
  it("is the loopback server the CLI binds when nothing names one", () => {
    expect(readApiTarget(undefined)).toBe("http://127.0.0.1:8787");
    // An exported-but-empty variable is a shell that set nothing, not a choice.
    expect(readApiTarget("")).toBe("http://127.0.0.1:8787");
  });

  it("is the origin of what was named, and never its path", () => {
    // The journeys name a throwaway fixture server; a path on it would be
    // prepended to every proxied read and answered by nothing.
    expect(readApiTarget("http://127.0.0.1:45751")).toBe(
      "http://127.0.0.1:45751",
    );
    expect(readApiTarget("https://reads.example.invalid/api/")).toBe(
      "https://reads.example.invalid",
    );
  });

  it("refuses a value that is not a URL, naming it", () => {
    // What this prevents: Vite accepts the string, and every read then fails
    // inside the proxy as a request error, which reads as the API being down.
    expect(() => readApiTarget("127.0.0.1:8787")).toThrow(
      "DAG_UI_API_URL is not a URL: 127.0.0.1:8787",
    );
    expect(() => readApiTarget("a host we mistyped")).toThrow(
      "DAG_UI_API_URL is not a URL: a host we mistyped",
    );
  });

  it("refuses a scheme the read API is not served over, naming it", () => {
    // A parseable URL is not a reachable one: this is where an operator's runs
    // would be read from somewhere nobody meant to name.
    expect(() => readApiTarget("ftp://reads.example.invalid")).toThrow(
      "DAG_UI_API_URL names ftp: and the read API is served over http or https",
    );
    expect(() => readApiTarget("file:///etc/passwd")).toThrow(
      "DAG_UI_API_URL names file: and the read API is served over http or https",
    );
  });
});
