import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Load `vite.config.ts` the way Vite does — freshly, so it reads the environment
 * as it stands now rather than as it stood when this file was first imported.
 */
async function loadConfig(target: string | undefined): Promise<unknown> {
  vi.resetModules();
  if (target === undefined) delete process.env.DAG_UI_API_URL;
  else process.env.DAG_UI_API_URL = target;
  const loaded = (await import("../../vite.config")) as { default: unknown };
  return loaded.default;
}

describe("the config every Vite server here loads", () => {
  const named = process.env.DAG_UI_API_URL;
  afterEach(() => {
    if (named === undefined) delete process.env.DAG_UI_API_URL;
    else process.env.DAG_UI_API_URL = named;
  });

  it("refuses to load against a proxy target that is not a URL", async () => {
    // What this buys: Vite accepts a bad target and then fails every proxied
    // read, which a reader meets as the API being down rather than as this
    // variable being wrong. The config stops instead, before a server binds.
    await expect(loadConfig("127.0.0.1:8787")).rejects.toThrow(/Invalid URL/);
    await expect(loadConfig("a host we mistyped")).rejects.toThrow(
      /Invalid URL/,
    );
  });

  it("proxies both read paths to the origin of what was named", async () => {
    // A path on the target would be prepended to every read and answered by
    // nothing, so what the proxy is given is the origin.
    const config = (await loadConfig(
      "http://127.0.0.1:45751/ignored/path",
    )) as {
      server?: { proxy?: Record<string, string> };
      preview?: { proxy?: Record<string, string> };
    };
    expect(config.server?.proxy?.["/api"]).toBe("http://127.0.0.1:45751");
    expect(config.server?.proxy?.["/healthz"]).toBe("http://127.0.0.1:45751");
    // `preview` serves the bundle the journeys drive, so it carries the same
    // proxy rather than falling back to Vite's own behaviour.
    expect(config.preview?.proxy?.["/healthz"]).toBe("http://127.0.0.1:45751");
  });
});
