// The workspace files compiling the crate reads: every target `cargo metadata` names,
// followed through `mod`, `#[path]` and `include*!`, cfg'd-out modules included because
// another build of the same tier can turn them on. It reads tokens rather than lines, so
// a `mod` or `include_str!` inside a comment or a string a journey writes out is not one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// Identifiers, string values and single punctuation characters, without comments.
export function rustTokens(text) {
  const tokens = [];
  let at = 0;
  const identifier = /[A-Za-z_][A-Za-z0-9_]*/y;
  const rawOpen = /b?r(#*)"/y;
  const lifetimeOrChar = /'(\\.[^']*'|[^\\']'|[A-Za-z_][A-Za-z0-9_]*)/y;
  while (at < text.length) {
    if (/\s/.test(text[at])) at += 1;
    else if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end;
    } else if (text.startsWith("/*", at)) {
      let depth = 1;
      at += 2;
      while (at < text.length && depth > 0) {
        const opens = text.startsWith("/*", at);
        if (!opens && !text.startsWith("*/", at)) {
          at += 1;
          continue;
        }
        depth += opens ? 1 : -1;
        at += 2;
      }
    } else {
      rawOpen.lastIndex = at;
      const raw = rawOpen.exec(text);
      if (raw) {
        const start = at + raw[0].length;
        const close = `"${raw[1]}`;
        const end = text.indexOf(close, start);
        tokens.push({ string: text.slice(start, end) });
        at = end + close.length;
        continue;
      }
      if (text[at] === '"' || text.startsWith('b"', at)) {
        let end = at + (text[at] === '"' ? 1 : 2);
        const start = end;
        while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
        tokens.push({ string: text.slice(start, end) });
        at = end + 1;
        continue;
      }
      if (text[at] === "'") {
        lifetimeOrChar.lastIndex = at;
        const quoted = lifetimeOrChar.exec(text);
        at += quoted ? quoted[0].length : 1;
        continue;
      }
      identifier.lastIndex = at;
      const word = identifier.exec(text);
      if (word) {
        tokens.push({ word: word[0] });
        at += word[0].length;
      } else if (/[0-9]/.test(text[at])) {
        at += /^[0-9A-Za-z_.]+/.exec(text.slice(at, at + 64))[0].length;
      } else {
        tokens.push({ punct: text[at] });
        at += 1;
      }
    }
  }
  return tokens;
}

const OPENING = { "(": ")", "[": "]", "{": "}" };
const isPunct = (token, value) => token?.punct === value;

// The index just past the group opening at `start`.
function pastGroup(tokens, start) {
  let depth = 0;
  for (let at = start; at < tokens.length; at += 1) {
    const { punct } = tokens[at];
    if (punct && OPENING[punct]) depth += 1;
    else if (punct && Object.values(OPENING).includes(punct)) {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return tokens.length;
}

// What a `path = "…"` attribute names, `cfg_attr` included.
function attributePath(tokens) {
  for (let at = 0; at + 2 < tokens.length; at += 1)
    if (
      tokens[at].word === "path" &&
      isPunct(tokens[at + 1], "=") &&
      tokens[at + 2].string !== undefined
    )
      return tokens[at + 2].string;
  return null;
}

// One `include*!` argument, relative to the including file or to the crate's root.
function includedPath(args, file, root) {
  const strings = args.filter((token) => token.string !== undefined);
  const plain = args.length === 1 && strings.length === 1;
  if (plain) return { path: join(dirname(file), strings[0].string) };
  const words = args.flatMap((token) => (token.word ? [token.word] : []));
  if (words.includes("concat") && words.includes("env")) {
    const [variable, ...rest] = strings;
    const suffix = rest.map((token) => token.string).join("");
    if (variable?.string === "OUT_DIR") return { generated: true };
    if (variable?.string === "CARGO_MANIFEST_DIR")
      return { path: join(root, suffix) };
  }
  return { unresolved: true };
}

function moduleFile(directory, name) {
  const flat = join(directory, `${name}.rs`);
  const nested = join(directory, name, "mod.rs");
  return existsSync(nested) && !existsSync(flat) ? nested : flat;
}

function walk(file, moduleDirectory, root, state) {
  if (state.files.has(file)) return;
  state.files.add(file);
  if (!existsSync(file)) return;
  const tokens = rustTokens(readFileSync(file, "utf8"));
  const inline = [];
  const blocks = [];
  let pendingPath = null;
  const scanMacros = (slice) => {
    for (let at = 0; at + 2 < slice.length; at += 1) {
      const name = slice[at].word;
      if (
        !["include", "include_str", "include_bytes"].includes(name) ||
        !isPunct(slice[at + 1], "!")
      )
        continue;
      const end = pastGroup(slice, at + 2);
      const found = includedPath(slice.slice(at + 3, end - 1), file, root);
      const where = relative(root, file);
      if (found.unresolved) state.unresolved.push(`${name}! in ${where}`);
      else if (found.path && name === "include")
        walk(found.path, dirname(found.path), root, state);
      else if (found.path) state.files.add(found.path);
    }
  };
  const directory = () => join(moduleDirectory, ...inline);
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (isPunct(token, "#")) {
      const open = isPunct(tokens[at + 1], "!") ? at + 2 : at + 1;
      if (!isPunct(tokens[open], "[")) continue;
      const end = pastGroup(tokens, open);
      const attribute = tokens.slice(open + 1, end - 1);
      pendingPath = attributePath(attribute) ?? pendingPath;
      scanMacros(attribute);
      at = end - 1;
    } else if (token.word === "mod" && tokens[at + 1]?.word) {
      const name = tokens[at + 1].word;
      if (isPunct(tokens[at + 2], ";")) {
        const base = inline.length ? directory() : dirname(file);
        if (pendingPath) {
          const target = join(base, pendingPath);
          walk(target, dirname(target), root, state);
        } else {
          const target = moduleFile(directory(), name);
          const ownsDirectory = basename(target) === "mod.rs";
          walk(
            target,
            ownsDirectory ? dirname(target) : join(directory(), name),
            root,
            state,
          );
        }
        pendingPath = null;
      } else if (isPunct(tokens[at + 2], "{")) {
        blocks.push(true);
        inline.push(pendingPath ?? name);
        pendingPath = null;
        at += 2;
      }
    } else if (isPunct(token, "{")) {
      blocks.push(false);
      pendingPath = null;
    } else if (isPunct(token, "}")) {
      if (blocks.pop()) inline.pop();
      pendingPath = null;
    } else if (isPunct(token, ";")) {
      pendingPath = null;
    } else if (
      ["include", "include_str", "include_bytes"].includes(token.word)
    ) {
      scanMacros(tokens.slice(at, pastGroup(tokens, at + 2)));
    }
  }
}

// The files `roots` read, relative to `root`, and any `include*!` naming no fixed path.
export function compiledFromRoots(root, roots) {
  const state = { files: new Set(), unresolved: [] };
  for (const file of roots) walk(file, dirname(file), root, state);
  return {
    files: [...state.files].map((file) => relative(root, file)).sort(),
    unresolved: state.unresolved.sort(),
  };
}

// Every Rust source a `cargo llvm-cov nextest` of the crate compiles, whatever its profile
// selects: the profile picks which tests run after every target has been built.
export function compiledReads(cwd) {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--offline", "--format-version", "1"],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const roots = metadata.packages.flatMap((pack) =>
    pack.targets.map((target) => target.src_path),
  );
  return compiledFromRoots(metadata.workspace_root, roots);
}
