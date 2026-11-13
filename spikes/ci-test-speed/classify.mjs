// Which brief category a recorded process's time belongs to, from its command
// name and arguments and from the Nx task that owns it.

// Processes whose own time is waiting on the processes they start: their
// time counts only when nothing beneath them is running (the leaf rule), or,
// where the platform records no parent, only when no other process is running.
export const CONTAINERS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "just",
  "env",
  "sudo",
  "timeout",
  "nice",
  "xargs",
  "cmd",
  "conhost",
  "pwsh",
  "powershell",
  "make",
  "Runner.Worker",
  "Runner.Listener",
  "runsvc.sh",
  "nohup",
  "script",
  "tee",
  "cat",
  "time",
]);

const RULES = [
  [
    /^(rustc|rustdoc|clippy-driver|build-script-|build_script_|coverage-rustc|sccache)/,
    "compile",
  ],
  [
    /^(cc|c\+\+|gcc|g\+\+|cc1|cc1plus|clang|clang\+\+|as|ar|ranlib|cl)$/,
    "compile-c",
  ],
  [
    /^(ld|ld\.bfd|ld\.gold|ld\.lld|lld|collect2|rust-lld|ld64|link|lld-link|mold)$/,
    "link",
  ],
  [
    /^(cargo|cargo-auditable|cargo-cyclonedx|cargo-clip|cargo-clippy|build-scri)$/,
    "cargo",
  ],
  [/^(llvm-profdata|llvm-cov|cargo-llvm-cov|llvm-readobj)$/, "coverage"],
  [/^(cargo-nextest|cargo-next)$/, "test-harness"],
  [/^onepipeline-api/, "server-under-test"],
  [/^onepipeline$/, "engine-cli"],
  [/^(git|git-remote-https?|git-upload-pack|git-receive-pack|ssh)$/, "git"],
  [/^(npm|npx|npm-cli)$/, "npm"],
  [/^bun$/, "bun"],
  [
    /^(python|python3|python3\.\d+|pip|pip3|uv|uvx|maturin|llmlint|pytest)$/,
    "python",
  ],
  [
    /^(chrome|chromium|headless_shell|chrome_crashpad|chrome_crashpad_handler|msedge|Google Chrome|firefox)/i,
    "browser",
  ],
  [/^(curl|wget|gh)$/, "network"],
  [
    /^(docker|dockerd|containerd|containerd-shim|runc|containerd-shim-runc-v2)$/,
    "container",
  ],
  [/^(esbuild|vite|tsc|biome|eslint|node_modules)$/, "js-tooling"],
  [/^(strace|bpftrace|auditpol|wevtutil|accton|lastcomm)$/, "tracer"],
  [/^(tar|zstd|gzip|unzip|zip|xz)$/, "archive"],
];

export function classify(p) {
  const comm = (p.comm ?? "").trim();
  const argv = p.argv ?? "";
  if (comm === "node" || comm === "MainThread" || /^node(\.exe)?$/.test(comm)) {
    if (/npm-cli\.js|npx-cli\.js|\/npm |\bnpm\b/.test(argv.slice(0, 120)))
      return "npm";
    if (/nx(\.js)?\b.*\b(run-many|affected|run)\b|nx\/bin|nx\/dist/.test(argv))
      return "nx";
    if (/fixture/.test(argv)) return "fixtures";
    if (/playwright/.test(argv)) return "js-test";
    if (/vitest/.test(argv)) return "js-test";
    if (/--test\b/.test(argv)) return "js-test";
    return "node";
  }
  // macOS keeps ten characters of a name: the engine CLI, the server and the
  // unit-test binary all read `onepipelin` there.
  if (comm === "onepipelin") return "onepipeline-truncated";
  for (const [re, cat] of RULES) if (re.test(comm)) return cat;
  // A Rust test binary: cargo names it `<target>-<16 hex digits>`.
  if (
    /-[0-9a-f]{16}$/.test(comm) ||
    /\/deps\/[A-Za-z0-9_]+-[0-9a-f]{16}/.test(argv)
  )
    return "rust-test";
  if (
    /^(e2e|packaging|contract|build_cach|checkout_p|plan_copy|plan_linea)-?[0-9a-f]*$/.test(
      comm,
    )
  )
    return "rust-test";
  if (
    /^(e2e|packaging|contract|onepipeline_ui|build_cache|checkout_paths|plan_copy|plan_linear)/.test(
      comm,
    )
  )
    return "rust-test";
  if (CONTAINERS.has(comm)) return "glue";
  return "other";
}

// The report's categories, in the brief's words, from the fine ones above.
export function group(cat, instrumented) {
  switch (cat) {
    case "compile":
    case "compile-c":
    case "cargo":
      return instrumented ? "compile (instrumented)" : "compile (plain)";
    case "link":
      return instrumented ? "link (instrumented)" : "link (plain)";
    case "coverage":
      return "coverage overhead (profdata, llvm-cov, merge)";
    case "rust-test":
    case "test-harness":
      return instrumented
        ? "Rust tests running (instrumented)"
        : "Rust tests running (plain)";
    case "server-under-test":
      return "server under test (onepipeline-api)";
    case "engine-cli":
      return "spawns: onepipeline engine CLI";
    case "git":
      return "spawns: git";
    case "npm":
      return "spawns: npm";
    case "bun":
      return "spawns: bun";
    case "python":
      return "spawns: Python (python, pip, uv, llmlint)";
    case "browser":
      return "spawns: browsers";
    case "network":
      return "spawns: network clients (curl, gh)";
    case "onepipeline-truncated":
      return "onepipeline* on macOS (engine CLI, server or unit-test binary)";
    case "fixtures":
      return "fixtures (fixture-building scripts)";
    case "container":
      return "container (manylinux wheel build)";
    case "js-test":
    case "node":
    case "js-tooling":
      return "JavaScript tests and tooling (node)";
    case "nx":
      return "Nx orchestration";
    case "sleep":
      return "sleeps";
    case "wait":
      return "polls and timeouts (waits that ended by timing out)";
    case "glue":
    case "archive":
      return "shell, just and archive glue";
    case "tracer":
      return "recorder (measurement-only)";
    default:
      return "other processes";
  }
}
