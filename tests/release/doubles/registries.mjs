#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Local doubles of the three package registries a release publishes to, in one
// process: PyPI (its JSON API, simple index and legacy upload), npm (packuments,
// tarballs and `npm publish`) and a crate registry (a sparse index and the
// publish API `cargo publish` speaks). Each serves what was uploaded to it, from
// a state directory the journeys in this directory can read and steer, so the
// real clients — twine, pip, npm, cargo and scripts/release-probe.sh — are what
// reach it.
//
//   node registries.mjs STATE_DIR
//
// It writes `STATE_DIR/port` once it listens. Under STATE_DIR:
//
//   pypi/<file>                  every wheel uploaded
//   npm/<package>/<version>.tgz  every npm package published, with .json beside it
//   crates/<name>-<vers>.crate   every crate published, with .json beside it
//   uploads.log                  one line per accepted upload: registry and file
//   control/fail/<file>          every upload of <file> answers 500 until the
//                                marker is removed — persistent, because the
//                                clients retry a 500 themselves
//   control/hide                 lines naming files or package@version this
//                                registry pretends not to serve
//   control/corrupt              lines naming files served with other bytes
//   control/broken               lines `<read>=<status>`, `<read>=malformed` or
//                                `crate-index=foreign` (JSON, not an entry) or
//                                `npm-packument=other-version` (each version's
//                                manifest names another),
//                                for the reads a release makes of a registry:
//                                pypi-json, npm-packument, crate-index and
//                                crate-api
//
// Prefixes: /pypi/..., /simple/..., /files/... and /legacy/ for PyPI; /npm/...
// for npm; /index/... and /api/v1/... for the crate registry.
//
// And the GitHub API, which release-plz cannot be pointed anywhere but
// api.github.com: STATE_DIR/proxy-port is an HTTPS proxy that answers
// `CONNECT api.github.com:443` itself, with a certificate for that name signed
// by a throwaway authority it writes to STATE_DIR/tls/ca.pem, and tunnels every
// other host through untouched. A client run with HTTPS_PROXY at it and
// SSL_CERT_FILE at that authority reaches this double instead of GitHub: every
// read is answered with nothing and every write refused, both logged to
// forge.log.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

const state = process.argv[2];
if (!state) {
  console.error("usage: registries.mjs STATE_DIR");
  process.exit(2);
}
for (const dir of ["pypi", "npm", "crates", "control/fail"])
  mkdirSync(join(state, dir), { recursive: true });

const lines = (name) =>
  existsSync(join(state, "control", name))
    ? readFileSync(join(state, "control", name), "utf8")
        .split("\n")
        .filter(Boolean)
    : [];
const hidden = (key) => lines("hide").includes(key);
// What a broken read answers instead, or nothing when it is not broken.
function broken(read, response) {
  const entry = lines("broken").find((line) => line.startsWith(`${read}=`));
  if (!entry) return false;
  const answer = entry.slice(read.length + 1);
  if (answer === "foreign") reply(response, 200, "{}\n", "text/plain");
  else if (answer === "malformed")
    reply(
      response,
      200,
      read === "crate-index" ? "{not json\n" : { urls: "not a list" },
    );
  else reply(response, Number(answer), { error: `the double broke ${read}` });
  return true;
}
const corrupted = (key) => lines("corrupt").includes(key);
const failing = (file) => existsSync(join(state, "control", "fail", file));
const served = (key, bytes) =>
  corrupted(key) ? Buffer.from(`not ${key}\n`) : bytes;
const accepted = (registry, file) =>
  appendFileSync(join(state, "uploads.log"), `${registry} ${file}\n`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Every name a client hands over becomes a path under STATE_DIR, so each is
// held to what a registry would accept before it is used as one.
const FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const PACKAGE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const valid = (pattern, value) =>
  typeof value === "string" && pattern.test(value) && !value.includes("..");

function reply(response, status, body, type = "application/json") {
  const bytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": type,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
const wheelVersion = (file) => file.split("-")[1];
const wheels = () =>
  readdirSync(join(state, "pypi")).filter(
    (file) => file.endsWith(".whl") && !hidden(file),
  );
const projectOf = (file) => normalize(file.split("-")[0]);

function multipart(request, bytes) {
  const boundary = request.headers["content-type"]?.match(
    /boundary="?([^";]+)"?/,
  )?.[1];
  const fields = {};
  if (!boundary) return fields;
  const delimiter = Buffer.from(`--${boundary}`);
  let start = bytes.indexOf(delimiter);
  while (start !== -1) {
    const next = bytes.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = bytes.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, split).toString();
    const name = headers.match(/name="([^"]+)"/)?.[1];
    const filename = headers.match(/filename="([^"]+)"/)?.[1];
    fields[name] = { filename, value: part.subarray(split + 4) };
    start = next;
  }
  return fields;
}

async function pypi(request, response, path) {
  if (request.method === "POST" && path === "/legacy/") {
    const fields = multipart(request, await body(request));
    const file = fields.content?.filename;
    if (!valid(FILE, file) || !file.endsWith(".whl"))
      return reply(response, 400, "not a wheel filename", "text/plain");
    if (failing(file))
      return reply(
        response,
        500,
        "the double failed this upload",
        "text/plain",
      );
    if (existsSync(join(state, "pypi", file)))
      return reply(response, 400, "File already exists.", "text/plain");
    writeFileSync(join(state, "pypi", file), fields.content.value);
    accepted("pypi", file);
    return reply(response, 200, "OK", "text/plain");
  }
  let match = path.match(/^\/pypi\/([^/]+)\/(?:([^/]+)\/)?json$/);
  if (match && broken("pypi-json", response)) return;
  if (match) {
    const [, project, version] = match;
    const files = wheels().filter((f) => projectOf(f) === normalize(project));
    const versions = [...new Set(files.map(wheelVersion))].sort();
    const wanted = version ?? versions.at(-1);
    const urls = files.filter((f) => wheelVersion(f) === wanted);
    if (!urls.length) return reply(response, 404, { message: "Not Found" });
    return reply(response, 200, {
      info: { name: project, version: wanted },
      urls: urls.map((filename) => ({
        filename,
        packagetype: "bdist_wheel",
        url: `http://${request.headers.host}/files/${filename}`,
      })),
    });
  }
  match = path.match(/^\/simple\/([^/]+)\/$/);
  if (match) {
    const links = wheels()
      .filter((f) => projectOf(f) === normalize(match[1]))
      .map((f) => {
        const hash = sha256(readFileSync(join(state, "pypi", f)));
        return `<a href="/files/${f}#sha256=${hash}">${f}</a>`;
      });
    if (!links.length) return reply(response, 404, "Not Found", "text/plain");
    return reply(
      response,
      200,
      `<!DOCTYPE html><html><body>${links.join("<br/>")}</body></html>`,
      "text/html",
    );
  }
  match = path.match(/^\/files\/([^/]+)$/);
  if (match && wheels().includes(match[1]))
    return reply(
      response,
      200,
      served(match[1], readFileSync(join(state, "pypi", match[1]))),
      "application/octet-stream",
    );
  return reply(response, 404, { message: "Not Found" });
}

function npmVersions(pkg) {
  if (!valid(PACKAGE, pkg)) return [];
  const dir = join(state, "npm", pkg);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((v) => !hidden(`${pkg}@${v}`))
    .sort();
}

function packument(host, pkg) {
  const versions = {};
  for (const version of npmVersions(pkg)) {
    const manifest = JSON.parse(
      readFileSync(join(state, "npm", pkg, `${version}.json`), "utf8"),
    );
    const tarball = readFileSync(join(state, "npm", pkg, `${version}.tgz`));
    versions[version] = {
      ...manifest,
      dist: {
        tarball: `http://${host}/npm/${pkg}/-/${pkg}-${version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
        shasum: createHash("sha1").update(tarball).digest("hex"),
      },
    };
  }
  return versions;
}

async function npm(request, response, path) {
  const tarball = path.match(/^\/([^/]+)\/-\/(.+)-(\d[^/]*)\.tgz$/);
  if (tarball && request.method === "GET") {
    const [, pkg, , version] = tarball;
    const file = join(state, "npm", pkg, `${version}.tgz`);
    if (!existsSync(file) || hidden(`${pkg}@${version}`))
      return reply(response, 404, { error: "Not found" });
    return reply(
      response,
      200,
      served(`${pkg}-${version}.tgz`, readFileSync(file)),
      "application/octet-stream",
    );
  }
  const latest = path.match(/^\/([^/]+)\/latest$/);
  if (latest) {
    const versions = packument(request.headers.host, latest[1]);
    const newest = Object.keys(versions).at(-1);
    if (!newest) return reply(response, 404, { error: "Not found" });
    return reply(response, 200, versions[newest]);
  }
  const pkg = decodeURIComponent(path.slice(1));
  const otherVersion = lines("broken").includes("npm-packument=other-version");
  if (
    request.method === "GET" &&
    !otherVersion &&
    broken("npm-packument", response)
  )
    return;
  if (request.method === "PUT") {
    if (!/^Bearer \S+/.test(request.headers.authorization ?? ""))
      return reply(response, 401, {
        error: "you must be logged in to publish",
      });
    const document = JSON.parse((await body(request)).toString());
    const [version, manifest] =
      Object.entries(document.versions ?? {})[0] ?? [];
    const [attachment] = Object.values(document._attachments ?? {});
    if (!valid(PACKAGE, pkg) || !valid(VERSION, version) || !attachment?.data)
      return reply(response, 400, {
        error: "not a package this registry takes",
      });
    const file = `${pkg}-${version}.tgz`;
    if (failing(file))
      return reply(response, 500, { error: "the double failed this publish" });
    if (existsSync(join(state, "npm", pkg, `${version}.json`)))
      return reply(response, 403, {
        error: `You cannot publish over the previously published versions: ${version}.`,
      });
    mkdirSync(join(state, "npm", pkg), { recursive: true });
    writeFileSync(
      join(state, "npm", pkg, `${version}.tgz`),
      Buffer.from(attachment.data, "base64"),
    );
    const { dist: _dist, ...rest } = manifest;
    writeFileSync(
      join(state, "npm", pkg, `${version}.json`),
      JSON.stringify(rest),
    );
    accepted("npm", file);
    return reply(response, 201, { ok: true });
  }
  const versions = packument(request.headers.host, pkg);
  if (otherVersion)
    for (const manifest of Object.values(versions))
      manifest.version = "0.0.0-other";
  const names = Object.keys(versions);
  if (!names.length) return reply(response, 404, { error: "Not found" });
  return reply(response, 200, {
    name: pkg,
    "dist-tags": { latest: names.at(-1) },
    versions,
  });
}

function crateVersions(name) {
  return readdirSync(join(state, "crates"))
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(state, "crates", f), "utf8")))
    .filter((entry) => !hidden(`${name}@${entry.vers}`));
}

async function crates(request, response, path) {
  if (path === "/index/config.json")
    return reply(response, 200, {
      dl: `http://${request.headers.host}/api/v1/crates`,
      api: `http://${request.headers.host}`,
    });
  const index = path.match(/^\/index\/(?:[^/]+\/){1,2}([^/]+)$/);
  if (index && broken("crate-index", response)) return;
  if (index) {
    const entries = crateVersions(index[1]);
    if (!entries.length) return reply(response, 404, "Not Found", "text/plain");
    return reply(
      response,
      200,
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "text/plain",
    );
  }
  if (request.method === "PUT" && path === "/api/v1/crates/new") {
    if (!request.headers.authorization)
      return reply(response, 403, { errors: [{ detail: "no token" }] });
    const bytes = await body(request);
    const length = bytes.readUInt32LE(0);
    const metadata = JSON.parse(bytes.subarray(4, 4 + length).toString());
    const crateLength = bytes.readUInt32LE(4 + length);
    const crate = bytes.subarray(8 + length, 8 + length + crateLength);
    if (!valid(PACKAGE, metadata.name) || !valid(VERSION, metadata.vers))
      return reply(response, 400, {
        errors: [{ detail: "invalid crate name or version" }],
      });
    const file = `${metadata.name}-${metadata.vers}.crate`;
    if (failing(file))
      return reply(response, 500, {
        errors: [{ detail: "the double failed" }],
      });
    if (existsSync(join(state, "crates", file)))
      return reply(response, 400, {
        errors: [
          { detail: `crate version \`${metadata.vers}\` is already uploaded` },
        ],
      });
    writeFileSync(join(state, "crates", file), crate);
    writeFileSync(
      join(state, "crates", `${metadata.name}-${metadata.vers}.json`),
      JSON.stringify({
        name: metadata.name,
        vers: metadata.vers,
        deps: [],
        cksum: sha256(crate),
        features: {},
        yanked: false,
      }),
    );
    accepted("crate", file);
    return reply(response, 200, {
      warnings: { invalid_categories: [], invalid_badges: [], other: [] },
    });
  }
  const api = path.match(/^\/api\/v1\/crates\/([^/]+)$/);
  if (api && broken("crate-api", response)) return;
  if (api) {
    const versions = crateVersions(api[1])
      .map((e) => e.vers)
      .sort();
    if (!versions.length) return reply(response, 404, { errors: [] });
    return reply(response, 200, {
      crate: {
        name: api[1],
        max_stable_version: versions.at(-1),
        newest_version: versions.at(-1),
      },
    });
  }
  return reply(response, 404, { errors: [{ detail: "Not Found" }] });
}

async function forge(request, response, path) {
  appendFileSync(join(state, "forge.log"), `${request.method} ${path}\n`);
  if (request.method !== "GET")
    return reply(response, 403, { message: "the forge double is read-only" });
  return reply(response, 200, []);
}

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://double").pathname;
  const route = request.socket.encrypted
    ? forge(request, response, path)
    : path.startsWith("/npm/")
      ? npm(request, response, path.slice(4))
      : path.startsWith("/index/") || path.startsWith("/api/")
        ? crates(request, response, path)
        : pypi(request, response, path);
  route.catch((error) => reply(response, 500, { error: error.message }));
});
// A certificate authority that exists for this process alone, and the one name
// it vouches for.
const tls = join(state, "tls");
mkdirSync(tls, { recursive: true });
const openssl = (...args) =>
  execFileSync("openssl", args, { cwd: tls, stdio: "pipe" });
openssl(
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "1",
  "-subj",
  "/CN=release journey double CA",
  "-keyout",
  "ca.key",
  "-out",
  "ca.pem",
);
openssl(
  "req",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-subj",
  "/CN=api.github.com",
  "-keyout",
  "api.key",
  "-out",
  "api.csr",
);
writeFileSync(join(tls, "api.ext"), "subjectAltName=DNS:api.github.com\n");
openssl(
  "x509",
  "-req",
  "-in",
  "api.csr",
  "-CA",
  "ca.pem",
  "-CAkey",
  "ca.key",
  "-CAcreateserial",
  "-days",
  "1",
  "-extfile",
  "api.ext",
  "-out",
  "api.pem",
);
const certificate = {
  key: readFileSync(join(tls, "api.key")),
  cert: readFileSync(join(tls, "api.pem")),
};

const proxy = createServer((_request, response) =>
  reply(response, 405, "CONNECT only", "text/plain"),
);
proxy.on("connect", (request, socket, head) => {
  const [host, port] = request.url.split(":");
  if (host === "api.github.com") {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const secure = new TLSSocket(socket, {
      isServer: true,
      ...certificate,
      ALPNProtocols: ["http/1.1"],
    });
    server.emit("connection", secure);
    if (head.length) secure.unshift(head);
    return;
  }
  const upstream = connect(Number(port || 443), host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(0, "127.0.0.1", () => {
  proxy.listen(0, "127.0.0.1", () => {
    writeFileSync(join(state, "proxy-port"), String(proxy.address().port));
    writeFileSync(join(state, "port"), String(server.address().port));
  });
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    proxy.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
