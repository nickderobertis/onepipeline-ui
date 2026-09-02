/**
 * The read API the dev server and `vite preview` proxy to, read from the
 * environment and validated where it arrives rather than trusted.
 *
 * It defaults to the loopback address and port `onepipeline-api serve` binds, and
 * the browser journeys override it to point at the throwaway fixture server they
 * start instead of at the operator's own runs.
 *
 * A proxy target is where every `/api` read a browser makes is sent, so a value
 * this refuses is one that would otherwise send an operator's run data somewhere
 * nobody named — and an unparseable one fails inside Vite's proxy as a request
 * error per read, which reads as the API being down rather than as this variable
 * being wrong. Refused here, once, naming the value.
 *
 * Its own module rather than a function in `vite.config.ts`, because that file is
 * evaluated by Vite as it starts a server: a test could only reach this by
 * importing the whole config, plugins and all, and would then be asserting on
 * plugin loading as much as on this.
 */
export function readApiTarget(named = process.env.DAG_UI_API_URL): string {
  if (named === undefined || named === "") return "http://127.0.0.1:8787";
  let parsed: URL;
  try {
    parsed = new URL(named);
  } catch {
    throw new Error(`DAG_UI_API_URL is not a URL: ${named}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `DAG_UI_API_URL names ${parsed.protocol} and the read API is served over http or https: ${named}`,
    );
  }
  return parsed.origin;
}
