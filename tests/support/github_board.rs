//! A loopback GitHub board, at the remote plugin's real HTTP boundary.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use serde_json::Value;

/// Owns the endpoint process and the directory containing its current board state.
pub struct GitHubBoard {
    child: Child,
    dir: PathBuf,
    pub url: String,
    pub token: String,
}

impl GitHubBoard {
    pub fn start(workspace: &Path) -> Self {
        let mut command = Command::new("python3");
        command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/github_board.py"));
        Self::start_with(workspace, command, None)
    }

    /// A board holding `seed`'s issues in place of the default plan and its one
    /// approval: the shape `github_board.py` documents, which it refuses whole
    /// before listening unless every issue is one GitHub could answer.
    pub fn start_seeded(workspace: &Path, seed: &Value) -> Self {
        let path = workspace.join("github-board-seed.json");
        std::fs::write(&path, seed.to_string()).expect("the board seed");
        let mut command = Command::new("python3");
        command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/github_board.py"));
        Self::start_with(workspace, command, Some(&path))
    }

    fn start_with(workspace: &Path, mut command: Command, seed: Option<&Path>) -> Self {
        let dir = workspace.join("github-board");
        std::fs::create_dir_all(&dir).expect("board directory");
        let mut random = [0_u8; 32];
        std::fs::File::open("/dev/urandom")
            .expect("system randomness")
            .read_exact(&mut random)
            .expect("fresh board credential");
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let child = command
            .arg(&dir)
            .args(seed)
            .env("CACHE_BOARD_TOKEN", &token)
            .spawn()
            .expect("the loopback board starts");
        // Own the child before waiting, so even a startup failure reaps it.
        let mut board = Self {
            child,
            dir,
            url: String::new(),
            token,
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !board.dir.join("endpoint").is_file() {
            assert!(
                board
                    .child
                    .try_wait()
                    .expect("board process status")
                    .is_none(),
                "the board exited before listening"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "the board did not listen"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        board.url = std::fs::read_to_string(board.dir.join("endpoint")).expect("board URL");
        board
    }

    pub fn state(&self) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(self.dir.join("state.json")).expect("board state"),
        )
        .expect("board JSON")
    }
}

impl Drop for GitHubBoard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn the_board_refuses_missing_and_relative_roots_before_writing() {
    for arguments in [Vec::<&str>::new(), vec!["relative-board"]] {
        let output = Command::new("python3")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/github_board.py"))
            .args(arguments)
            .output()
            .expect("run the board with invalid arguments");
        assert_eq!(output.status.code(), Some(2));
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("error:"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn the_board_refuses_missing_and_empty_credentials_before_writing() {
    for token in [None, Some(""), Some("   ")] {
        let dir = tempfile::tempdir().expect("board directory");
        let mut command = Command::new("python3");
        command
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/github_board.py"))
            .arg(dir.path())
            .env_remove("CACHE_BOARD_TOKEN");
        if let Some(token) = token {
            command.env("CACHE_BOARD_TOKEN", token);
        }
        let output = command
            .output()
            .expect("run the board without a credential");
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("CACHE_BOARD_TOKEN"));
        assert!(std::fs::read_dir(dir.path())
            .expect("board directory")
            .next()
            .is_none());
    }
}

#[test]
fn the_board_refuses_a_seed_github_could_not_answer_before_listening() {
    let issue = |state: &str, reason: Option<&str>| {
        serde_json::json!({"number": 7, "title": "issue 7", "content": "", "metadata": {},
            "status": "Todo", "state": state, "reason": reason, "parent": null})
    };
    let seed = |issue: Value| {
        serde_json::json!({"repository": "owner/service", "options": ["Todo", "Done"],
            "issues": {"seven": issue}})
    };
    for refused in [
        // An open issue closed for a reason, and a closed one for none GitHub has.
        seed(issue("OPEN", Some("COMPLETED"))),
        seed(issue("CLOSED", Some("SHIPPED"))),
        // A card at an option the board does not carry.
        serde_json::json!({"repository": "owner/service", "options": ["Done"],
            "issues": {"seven": issue("OPEN", None)}}),
        // A repository that is no `owner/name`.
        serde_json::json!({"repository": "service", "options": ["Todo"],
            "issues": {"seven": issue("OPEN", None)}}),
    ] {
        let dir = tempfile::tempdir().expect("board directory");
        let path = dir.path().join("seed.json");
        std::fs::write(&path, refused.to_string()).expect("the seed");
        let output = Command::new("python3")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/github_board.py"))
            .arg(dir.path())
            .arg(&path)
            .env("CACHE_BOARD_TOKEN", "a-board-credential")
            .output()
            .expect("run the board with a seed it refuses");
        assert_eq!(output.status.code(), Some(2), "{refused}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("error:"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!dir.path().join("endpoint").exists(), "{refused}");
    }

    // The same seed made answerable is served, with its issue read by number.
    let dir = tempfile::tempdir().expect("board workspace");
    let board = GitHubBoard::start_seeded(dir.path(), &seed(issue("CLOSED", Some("DUPLICATE"))));
    assert_eq!(board.state()["issues"]["seven"]["number"], 7);
    assert_eq!(board.state()["issues"]["seven"]["reason"], "DUPLICATE");
}

#[test]
fn the_numeric_loopback_board_serves_even_when_hostname_lookup_is_unavailable() {
    let dir = tempfile::tempdir().expect("board workspace");
    let mut command = Command::new("python3");
    // Inject a DNS failure at the OS-facing seam; the board and HTTP socket stay real.
    command
        .args(["-c", "import runpy, socket, sys; socket.getfqdn = lambda *_: (_ for _ in ()).throw(RuntimeError('hostname lookup unavailable')); script = sys.argv.pop(1); runpy.run_path(script, run_name='__main__')"])
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/github_board.py"));
    let board = GitHubBoard::start_with(dir.path(), command, None);
    let address = board
        .url
        .strip_prefix("http://")
        .expect("HTTP URL")
        .parse()
        .expect("numeric loopback");
    let response = crate::http::post(
        address,
        "/graphql",
        r#"{"query":"query { viewer { login } }","variables":{}}"#,
    );
    assert_eq!(response.status, 401);
    assert_eq!(
        response.json()["errors"][0]["message"],
        "invalid board token"
    );
}
