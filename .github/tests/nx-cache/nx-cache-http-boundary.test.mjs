import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubCache } from "./nx-cache-journey.mjs";

test("the GitHub HTTP double rejects malformed requests and still stores a valid upload", async () => {
  const cache = await new GithubCache().start();
  const headers = { authorization: "Bearer refs/pull/1/merge" };
  const rpc = (method, body) =>
    fetch(
      `${cache.url}/twirp/github.actions.results.api.v1.CacheService/${method}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      },
    );
  const put = (url, body) =>
    fetch(url, { method: "PUT", body, signal: AbortSignal.timeout(5000) });
  try {
    cache.metadata.set("/repos/test/repo/actions/runs", { workflow_runs: [] });
    for (const query of [
      "page=banana",
      "page=0",
      "page=1.5",
      "page=",
      "per_page=101",
      "per_page=-1",
    ]) {
      const answer = await fetch(
        `${cache.url}/repos/test/repo/actions/runs?${query}`,
      );
      assert.equal(answer.status, 400, query);
      await answer.arrayBuffer();
    }
    const malformed = await fetch(
      `${cache.url}/twirp/CacheService/CreateCacheEntry`,
      {
        method: "POST",
        headers,
        body: "{",
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(malformed.status, 400);
    await malformed.arrayBuffer();
    for (const body of [
      null,
      [],
      {},
      { key: 3, version: "v1" },
      { key: "key", version: "" },
    ]) {
      const answer = await rpc("CreateCacheEntry", body);
      assert.equal(answer.status, 400);
      await answer.arrayBuffer();
    }
    const absent = await rpc("FinalizeCacheEntryUpload", {
      key: "boundary",
      version: "v1",
    });
    assert.equal(absent.status, 404);
    await absent.arrayBuffer();
    const created = await rpc("CreateCacheEntry", {
      key: "boundary",
      version: "v1",
    });
    assert.equal(created.status, 200);
    const { signedUploadUrl } = await created.json();
    const unknown = await put(`${cache.url}/upload/9999`, "bytes");
    assert.equal(unknown.status, 404);
    await unknown.arrayBuffer();
    const badOperation = await put(`${signedUploadUrl}?comp=unknown`, "bytes");
    assert.equal(badOperation.status, 400);
    await badOperation.arrayBuffer();
    const incomplete = await rpc("FinalizeCacheEntryUpload", {
      key: "boundary",
      version: "v1",
    });
    assert.equal(incomplete.status, 409);
    await incomplete.arrayBuffer();
    const missingBlock = await put(
      `${signedUploadUrl}?comp=blocklist`,
      "<BlockList><Latest>bm90LWhlcmU=</Latest></BlockList>",
    );
    assert.equal(missingBlock.status, 400);
    await missingBlock.arrayBuffer();
    const id = Buffer.from("block-1").toString("base64");
    const block = await put(
      `${signedUploadUrl}?comp=block&blockid=${encodeURIComponent(id)}`,
      "real upload bytes",
    );
    assert.equal(block.status, 201);
    await block.arrayBuffer();
    const list = await put(
      `${signedUploadUrl}?comp=blocklist`,
      `<BlockList><Latest>${id}</Latest></BlockList>`,
    );
    assert.equal(list.status, 201);
    await list.arrayBuffer();
    const finalized = await rpc("FinalizeCacheEntryUpload", {
      key: "boundary",
      version: "v1",
    });
    assert.equal(finalized.status, 200);
    await finalized.arrayBuffer();
    const found = await rpc("GetCacheEntryDownloadURL", {
      key: "boundary",
      version: "v1",
    });
    const { signedDownloadUrl } = await found.json();
    const downloaded = await fetch(signedDownloadUrl);
    assert.equal(await downloaded.text(), "real upload bytes");
    const recovered = await fetch(
      `${cache.url}/repos/test/repo/actions/runs?page=1&per_page=100`,
    );
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { workflow_runs: [] });
  } finally {
    await cache.close();
  }
});
