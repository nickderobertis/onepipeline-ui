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
    if (value !== undefined && isHostName(value)) return value;
  }
  try {
    const named = readFileSync("/etc/hostname", "utf8").trim();
    if (isHostName(named)) return named;
  } catch {
    // No such file: the engine falls back the same way.
  }
  return "localhost";
}

/**
 * Whether a string is a host name this fixture will write into a launch record
 * and hand a server as its own: labels of letters, digits and hyphens joined by
 * dots, at most 253 characters. Anything else — a blank, a path, a line of
 * something that is not a name — falls through to the next source, as a value
 * nothing could have recorded as a host.
 */
function isHostName(value) {
  return (
    /^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/u.test(
      value,
    ) && value.length <= 253
  );
}
