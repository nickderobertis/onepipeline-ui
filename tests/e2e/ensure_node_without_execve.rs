//! `scripts/ensure-node-without-execve.sh`, driven the way the
//! `_ensure-node-without-execve` recipe drives it: as a direct subprocess given
//! the host as just names it and the path the justfile exports, against a local
//! mirror laid out the way nodejs.org/dist is — as a directory, and once served
//! over real HTTPS from this machine.
//!
//! The node it provisions is what makes the npm launcher's refusal journey a
//! journey about a real release, so what is held here is that the real release
//! is what gets installed, that it stays installed and is replaced only by
//! itself, and that nothing else takes its place. The mirror serves the genuine
//! archive — the one this clone's own provisioning verified and kept, which the
//! `onepipeline-ui-npm-launcher` tier provisions before it runs — so these
//! journeys run offline over the real bytes.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

const PATH_ENV: &str = "ONEPIPELINE_UI_NODE_WITHOUT_EXECVE";
const DIST_ENV: &str = "ONEPIPELINE_UI_NODE_DIST";

/// This host as just's `os()` and `arch()` name it, which is what the recipe
/// passes: both are Rust's own names for the platform.
fn host() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Run the script for this host with `node` as the exported path and `dist` as
/// the mirror.
fn provision(node: Option<&Path>, dist: Option<&Path>) -> Output {
    provision_with(&[&host()], node, dist.map(Path::as_os_str))
}

/// The same, with `args` as the script's arguments and `dist` as any value.
fn provision_with(args: &[&str], node: Option<&Path>, dist: Option<&std::ffi::OsStr>) -> Output {
    provision_command(args, node, dist)
        .output()
        .expect("bash is on PATH")
}

/// The script's invocation, for a journey that adds to its environment.
fn provision_command(
    args: &[&str],
    node: Option<&Path>,
    dist: Option<&std::ffi::OsStr>,
) -> Command {
    let mut command = Command::new("bash");
    command
        .arg(repo_root().join("scripts/ensure-node-without-execve.sh"))
        .args(args)
        .env_remove(PATH_ENV)
        .env_remove(DIST_ENV);
    if let Some(node) = node {
        command.env(PATH_ENV, node);
    }
    if let Some(dist) = dist {
        command.env(DIST_ENV, dist);
    }
    command
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn a_call_without_the_exported_path_is_a_usage_error() {
    let output = provision(None, None);
    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("just _ensure-node-without-execve"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn a_call_that_names_no_host_or_more_than_one_is_a_usage_error() {
    let scratch = tempfile::tempdir().expect("temp dir");
    let node = scratch.path().join("node-without-execve/bin/node");
    for args in [vec![], vec![host(), host()]] {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = provision_with(&args, Some(&node), None);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}: {}",
            stderr(&output)
        );
        assert!(
            stderr(&output).contains("needs exactly the host"),
            "{args:?}: {}",
            stderr(&output)
        );
    }
}

/// A host nodejs.org publishes no pinned archive for is refused, naming it.
#[test]
fn a_host_with_no_pinned_release_is_refused() {
    let scratch = tempfile::tempdir().expect("temp dir");
    let home = scratch.path().join("node-without-execve");
    let output = provision_with(&["freebsd-riscv64"], Some(&home.join("bin/node")), None);
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("no pinned Node")
            && stderr(&output).contains("for freebsd-riscv64"),
        "{}",
        stderr(&output)
    );
    assert!(!home.exists());
}

/// Windows has no exec for the launcher to refuse, so nothing there runs this
/// node and nothing is fetched for it.
#[test]
fn a_windows_host_provisions_nothing() {
    let scratch = tempfile::tempdir().expect("temp dir");
    let home = scratch.path().join("tools/node-without-execve");
    let output = provision_with(&["windows-x86_64"], Some(&home.join("bin/node")), None);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert!(
        !scratch.path().join("tools").exists(),
        "Windows provisioned a node nothing runs"
    );
}

#[test]
fn a_path_that_is_not_a_node_binary_is_a_usage_error() {
    let scratch = tempfile::tempdir().expect("temp dir");
    let output = provision(Some(&scratch.path().join("node")), None);
    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("must name <dir>/bin/node"),
        "{}",
        stderr(&output)
    );
    assert_eq!(
        std::fs::read_dir(scratch.path()).expect("scratch").count(),
        0,
        "a refused call wrote something"
    );
}

/// The pinned release, as the script spells it.
#[cfg(unix)]
fn pinned_version() -> String {
    let script = std::fs::read_to_string(repo_root().join("scripts/ensure-node-without-execve.sh"))
        .expect("the script reads");
    script
        .lines()
        .find_map(|line| line.strip_prefix("version=\""))
        .and_then(|rest| rest.strip_suffix('"'))
        .expect("the script pins a version")
        .to_owned()
}

/// The archive name nodejs.org gives this host's release.
#[cfg(unix)]
fn asset() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("node-v{}-{os}-{arch}.tar.gz", pinned_version())
}

/// The genuine archive, as this clone's provisioning verified and kept it.
#[cfg(unix)]
fn genuine_archive() -> Vec<u8> {
    let kept = repo_root().join(".tools/node-without-execve.tar.gz");
    std::fs::read(&kept).unwrap_or_else(|error| {
        panic!(
            "no verified archive at {} ({error}); run the \
             `onepipeline-ui:ensure-node-without-execve` target",
            kept.display()
        )
    })
}

/// A scratch install location and a mirror beside it, laid out as
/// nodejs.org/dist, serving `archive` as this host's release — or nothing.
#[cfg(unix)]
struct Scratch {
    dir: tempfile::TempDir,
}

#[cfg(unix)]
impl Scratch {
    fn serving(archive: Option<&[u8]>) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let release = dir
            .path()
            .join("dist")
            .join(format!("v{}", pinned_version()));
        std::fs::create_dir_all(&release).expect("mirror layout");
        if let Some(archive) = archive {
            std::fs::write(release.join(asset()), archive).expect("serve the archive");
        }
        Self { dir }
    }

    fn mirror(&self) -> PathBuf {
        self.dir.path().join("dist")
    }

    /// A mirror that serves nothing, so a run that fetches fails naming it.
    fn empty_mirror(&self) -> PathBuf {
        let empty = self.dir.path().join("empty");
        std::fs::create_dir_all(&empty).expect("empty mirror");
        empty
    }

    fn tools(&self) -> PathBuf {
        self.dir.path().join("tools")
    }

    fn home(&self) -> PathBuf {
        self.tools().join("node-without-execve")
    }

    fn node(&self) -> PathBuf {
        self.home().join("bin/node")
    }

    fn stamp(&self) -> PathBuf {
        self.tools().join("node-without-execve.source")
    }

    fn kept(&self) -> PathBuf {
        self.tools().join("node-without-execve.tar.gz")
    }

    fn provision_from(&self, dist: &Path) -> Output {
        provision(Some(&self.node()), Some(dist))
    }

    /// What the installed node answers about the API and its own release.
    fn installed(&self) -> String {
        let output = Command::new(self.node())
            .args(["-p", "process.version + ' ' + typeof process.execve"])
            .output()
            .unwrap_or_else(|error| panic!("{} does not run: {error}", self.node().display()));
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }
}

#[cfg(unix)]
fn release_without_execve() -> String {
    format!("v{} undefined", pinned_version())
}

#[cfg(unix)]
#[test]
fn the_pinned_release_is_installed_stamped_and_kept() {
    let genuine = genuine_archive();
    let scratch = Scratch::serving(Some(&genuine));
    let output = scratch.provision_from(&scratch.mirror());

    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(scratch.installed(), release_without_execve());
    let stamp = std::fs::read_to_string(scratch.stamp()).expect("the install is stamped");
    assert_eq!(
        stamp.trim().len(),
        64,
        "the stamp is not a digest: {stamp:?}"
    );
    assert!(
        std::fs::read(scratch.kept()).expect("the archive is kept") == genuine,
        "the kept archive is not the one the mirror served"
    );
}

#[cfg(unix)]
#[test]
fn a_provisioned_node_is_used_as_it_is_without_fetching() {
    let scratch = Scratch::serving(Some(&genuine_archive()));
    let first = scratch.provision_from(&scratch.mirror());
    assert_eq!(first.status.code(), Some(0), "{}", stderr(&first));
    // A file the release does not carry, which only an untouched install keeps.
    let mark = scratch.home().join("left-in-place");
    std::fs::write(&mark, "").expect("mark the install");

    let again = scratch.provision_from(&scratch.empty_mirror());
    assert_eq!(
        again.status.code(),
        Some(0),
        "a provisioned node was fetched again: {}",
        stderr(&again)
    );
    assert!(mark.exists(), "a provisioned node was installed again");
    assert_eq!(scratch.installed(), release_without_execve());
}

/// An install that is no longer the pinned release — a stamp naming another
/// archive, or a node that has `process.execve` in its place — is replaced from
/// the archive kept beside it, without fetching.
#[cfg(unix)]
#[test]
fn a_stale_install_is_replaced_from_the_kept_archive() {
    let scratch = Scratch::serving(Some(&genuine_archive()));
    let first = scratch.provision_from(&scratch.mirror());
    assert_eq!(first.status.code(), Some(0), "{}", stderr(&first));
    let stamped = std::fs::read_to_string(scratch.stamp()).expect("the install is stamped");

    std::fs::write(scratch.stamp(), "another archive\n").expect("restamp");
    let restamped = scratch.provision_from(&scratch.empty_mirror());
    assert_eq!(restamped.status.code(), Some(0), "{}", stderr(&restamped));
    assert_eq!(
        std::fs::read_to_string(scratch.stamp()).expect("stamped again"),
        stamped
    );

    // The host's own node has the API; standing it where the old one was is the
    // install having become a node the refusal journey cannot use.
    std::fs::remove_file(scratch.node()).expect("remove the installed node");
    let host = String::from_utf8(
        Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("node is on PATH")
            .stdout,
    )
    .expect("utf-8 path");
    std::os::unix::fs::symlink(host.trim(), scratch.node()).expect("stand the host node there");
    let replaced = scratch.provision_from(&scratch.empty_mirror());
    assert_eq!(replaced.status.code(), Some(0), "{}", stderr(&replaced));
    assert_eq!(scratch.installed(), release_without_execve());
}

/// A replacement that fails its checks gives up nothing: the install, its
/// stamp and the archive are what they were — whether the replacement's archive
/// failed its digest or never arrived from the mirror at all.
#[cfg(unix)]
#[test]
fn a_refused_replacement_leaves_the_existing_install_in_place() {
    let scratch = Scratch::serving(Some(&genuine_archive()));
    let first = scratch.provision_from(&scratch.mirror());
    assert_eq!(first.status.code(), Some(0), "{}", stderr(&first));

    std::fs::write(scratch.stamp(), "another archive\n").expect("restamp");
    std::fs::write(scratch.kept(), b"no longer the release").expect("spoil the kept archive");
    let impostor = Scratch::serving(Some(b"not the release nodejs.org published"));
    let refused = scratch.provision_from(&impostor.mirror());

    assert_eq!(refused.status.code(), Some(1), "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains("never update the pin"),
        "{}",
        stderr(&refused)
    );
    assert_eq!(scratch.installed(), release_without_execve());
    assert_eq!(
        std::fs::read_to_string(scratch.stamp()).expect("the stamp is still there"),
        "another archive\n"
    );

    let uncopied = scratch.provision_from(&scratch.empty_mirror());
    assert_eq!(uncopied.status.code(), Some(1), "{}", stderr(&uncopied));
    assert!(
        stderr(&uncopied).contains("could not copy"),
        "{}",
        stderr(&uncopied)
    );
    assert_eq!(scratch.installed(), release_without_execve());
    assert_eq!(
        std::fs::read_to_string(scratch.stamp()).expect("the stamp is still there"),
        "another archive\n"
    );
}

#[cfg(unix)]
#[test]
fn an_archive_that_is_not_the_pinned_release_is_refused_and_installs_nothing() {
    let scratch = Scratch::serving(Some(b"not the release nodejs.org published"));
    let output = scratch.provision_from(&scratch.mirror());

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("not the") && stderr(&output).contains("never update the pin"),
        "{}",
        stderr(&output)
    );
    assert!(!scratch.home().exists(), "a refused archive was installed");
    assert!(!scratch.stamp().exists(), "a refused archive was stamped");
    assert!(!scratch.kept().exists(), "a refused archive was kept");
    let left: Vec<_> = std::fs::read_dir(scratch.tools())
        .expect("the tools directory")
        .collect();
    assert!(left.is_empty(), "the refusal left work behind: {left:?}");
}

#[cfg(unix)]
#[test]
fn a_mirror_without_the_release_names_what_it_is_missing() {
    let scratch = Scratch::serving(None);
    let output = scratch.provision_from(&scratch.mirror());

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains(&format!(
            "could not copy v{}/{} from the mirror",
            pinned_version(),
            asset()
        )) && stderr(&output).contains("No such file"),
        "{}",
        stderr(&output)
    );
    assert!(!scratch.home().exists());
}

#[cfg(unix)]
#[test]
fn a_mirror_that_is_neither_https_nor_a_directory_is_a_usage_error() {
    let scratch = Scratch::serving(None);
    let output = provision_with(
        &[&host()],
        Some(&scratch.node()),
        Some(std::ffi::OsStr::new("http://nodejs.org/dist")),
    );
    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("neither an https URL nor a directory"),
        "{}",
        stderr(&output)
    );
    assert!(!scratch.home().exists());
}

/// A release server that cannot be reached is named with curl's own reason,
/// and nothing is installed. Nothing listens on the discard port of the
/// loopback address, so this asks the network nothing.
#[cfg(unix)]
#[test]
fn an_unreachable_release_server_is_named_and_installs_nothing() {
    let scratch = Scratch::serving(None);
    let output = provision_with(
        &[&host()],
        Some(&scratch.node()),
        Some(std::ffi::OsStr::new("https://127.0.0.1:9")),
    );
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains(&format!(
            "could not download https://127.0.0.1:9/v{}/{} (curl:",
            pinned_version(),
            asset()
        )),
        "{}",
        stderr(&output)
    );
    assert!(!scratch.home().exists());
}

/// A release server on this machine, speaking real TLS: Python's own HTTPS
/// server over a directory, with a certificate made for the one journey and
/// handed to curl as the only authority it trusts. The script reaches it
/// exactly as it reaches nodejs.org, and nothing leaves the machine.
#[cfg(unix)]
struct HttpsMirror {
    server: std::process::Child,
    port: u16,
    authority: PathBuf,
    _keys: tempfile::TempDir,
}

#[cfg(unix)]
const HTTPS_SERVER: &str = "\
import functools, http.server, ssl, sys
root, cert, key = sys.argv[1:4]
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
print(server.server_address[1], flush=True)
server.serve_forever()
";

#[cfg(unix)]
impl HttpsMirror {
    fn over(root: &Path) -> Self {
        use std::io::BufRead;
        let keys = tempfile::tempdir().expect("temp dir");
        let (cert, key) = (keys.path().join("cert.pem"), keys.path().join("key.pem"));
        let made = Command::new("openssl")
            .args([
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            ])
            .args([
                "-subj",
                "/CN=127.0.0.1",
                "-addext",
                "subjectAltName=IP:127.0.0.1",
            ])
            .arg("-keyout")
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()
            .expect("openssl is on PATH");
        assert!(
            made.status.success(),
            "openssl made no certificate: {}",
            String::from_utf8_lossy(&made.stderr)
        );
        let mut server = Command::new("python3")
            .args(["-I", "-c", HTTPS_SERVER])
            .arg(root)
            .arg(&cert)
            .arg(&key)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("python3 is on PATH");
        let mut announced = String::new();
        std::io::BufReader::new(server.stdout.take().expect("the server's stdout"))
            .read_line(&mut announced)
            .expect("the server announces its port");
        let Ok(port) = announced.trim().parse() else {
            let _ = server.kill();
            panic!("the HTTPS server announced no port: {announced:?}");
        };
        Self {
            server,
            port,
            authority: cert,
            _keys: keys,
        }
    }

    fn url(&self) -> String {
        format!("https://127.0.0.1:{}", self.port)
    }
}

#[cfg(unix)]
impl Drop for HttpsMirror {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
    }
}

/// The pinned release, fetched over HTTPS the way a fresh clone fetches it from
/// nodejs.org: downloaded by curl, held to its digest, installed and kept.
#[cfg(unix)]
#[test]
fn the_pinned_release_is_fetched_over_https() {
    let genuine = genuine_archive();
    let scratch = Scratch::serving(Some(&genuine));
    let mirror = HttpsMirror::over(&scratch.mirror());
    let output = provision_command(
        &[&host()],
        Some(&scratch.node()),
        Some(std::ffi::OsStr::new(&mirror.url())),
    )
    .env("CURL_CA_BUNDLE", &mirror.authority)
    .output()
    .expect("bash is on PATH");

    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(scratch.installed(), release_without_execve());
    assert!(
        std::fs::read(scratch.kept()).expect("the archive is kept") == genuine,
        "what the server sent is not the archive it served"
    );
}

/// Set `path`'s permission bits, for the journeys whose subject is a tree this
/// user cannot write.
#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

#[cfg(unix)]
#[test]
fn a_tools_directory_that_cannot_be_written_is_named() {
    let scratch = Scratch::serving(Some(&genuine_archive()));
    std::fs::create_dir_all(scratch.tools()).expect("the tools directory");
    set_mode(&scratch.tools(), 0o555);
    let output = scratch.provision_from(&scratch.mirror());
    set_mode(&scratch.tools(), 0o755);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("could not create a working directory")
            && stderr(&output).contains("Permission denied"),
        "{}",
        stderr(&output)
    );
    assert!(!scratch.home().exists());
}

/// A kept archive no hasher can read is never taken as matching: the run stops
/// naming both tools' own answers, and the install it would have replaced stays.
#[cfg(unix)]
#[test]
fn a_kept_archive_no_hasher_can_read_is_refused_naming_both() {
    let scratch = Scratch::serving(Some(&genuine_archive()));
    let first = scratch.provision_from(&scratch.mirror());
    assert_eq!(first.status.code(), Some(0), "{}", stderr(&first));
    std::fs::write(scratch.stamp(), "another archive\n").expect("restamp");
    set_mode(&scratch.kept(), 0o000);
    let output = scratch.provision_from(&scratch.mirror());
    set_mode(&scratch.kept(), 0o644);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("neither sha256sum nor shasum could hash")
            && stderr(&output).contains("Permission denied"),
        "{}",
        stderr(&output)
    );
    assert_eq!(scratch.installed(), release_without_execve());
}

/// An install the replacement cannot remove is named with the reason, and the
/// stamp still says it is not the pinned release, so the next run tries again.
#[cfg(unix)]
#[test]
fn an_install_that_cannot_be_replaced_is_named_and_stays_unstamped() {
    let scratch = Scratch::serving(Some(&genuine_archive()));
    let first = scratch.provision_from(&scratch.mirror());
    assert_eq!(first.status.code(), Some(0), "{}", stderr(&first));
    std::fs::write(scratch.stamp(), "another archive\n").expect("restamp");
    let bin = scratch.home().join("bin");
    set_mode(&bin, 0o555);
    let output = scratch.provision_from(&scratch.empty_mirror());
    set_mode(&bin, 0o755);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("could not install the verified archive")
            && stderr(&output).contains("Permission denied"),
        "{}",
        stderr(&output)
    );
    let stamp = std::fs::read_to_string(scratch.stamp()).unwrap_or_default();
    assert_ne!(
        stamp.trim().len(),
        64,
        "a replacement that failed left the install stamped as the pinned release"
    );
}
