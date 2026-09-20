import { readFileSync } from "node:fs";

/**
 * This host's name, read the way the engine reads it — `HOSTNAME`, then
 * `COMPUTERNAME`, then `/etc/hostname`, else `localhost` — so a launch record the
 * fixture writes as recorded on *this* host is one the engine's liveness reading
 * agrees was. The served API is started with the same value in its environment,
 * so the two readings cannot disagree however the host is named.
 */
export function thisHost() {
  for (const key of ["HOSTNAME", "COMPUTERNAME"]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  try {
    const named = readFileSync("/etc/hostname", "utf8").trim();
    if (named !== "") return named;
  } catch {
    // No such file: the engine falls back the same way.
  }
  return "localhost";
}
