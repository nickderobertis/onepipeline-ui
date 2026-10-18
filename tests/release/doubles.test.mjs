// The registry doubles every journey here shares, held to the names and
// destinations they accept. A double one malformed request can take down fails
// every journey after it for a reason none of them is about, so a name that is
// not a registry's and a CONNECT that names no usable port are refused as a
// registry and a proxy would refuse them, and the doubles go on answering.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import { registryDoubles, scratch } from "./support.mjs";

let registries;
before(async () => {
  registries = await registryDoubles(scratch("doubles"));
});
after(async () => {
  await registries?.close();
});

// The answer the proxy gives a raw CONNECT for `authority`.
function tunnel(authority) {
  const port = Number(new URL(registries.forgeEnv.HTTPS_PROXY).port);
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      ),
    );
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk;
    });
    socket.on("end", () => done(answer));
    socket.on("error", fail);
  });
}

test("a CONNECT naming no usable port is refused and the doubles keep answering", async () => {
  for (const authority of ["127.0.0.1:99999", "127.0.0.1:0", "127.0.0.1:port"])
    assert.match(await tunnel(authority), /^HTTP\/1\.1 400 /, authority);
  const response = await fetch(`${registries.npm}absent/latest`);
  assert.equal(response.status, 404);
});

test("a tarball request naming no valid package or version is not found", async () => {
  for (const path of [
    "Upper/-/Upper-1.0.0.tgz",
    "a..b/-/a..b-1.0.0.tgz",
    "absent/-/absent-1.0.0..1.tgz",
  ]) {
    const response = await fetch(`${registries.npm}${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "Not found" }, path);
  }
  assert.deepEqual(registries.served(), []);
});
