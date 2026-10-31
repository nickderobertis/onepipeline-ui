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
        // Two issues under one number, and an issue that is its own parent.
        serde_json::json!({"repository": "owner/service", "options": ["Todo"],
            "issues": {"seven": issue("OPEN", None), "again": issue("OPEN", None)}}),
        serde_json::json!({"repository": "owner/service", "options": ["Todo"],
            "issues": {"seven": {"number": 7, "title": "issue 7", "content": "",
                "metadata": {}, "status": "Todo", "state": "OPEN", "reason": null,
                "parent": "seven"}}}),
        // A state and a parent that are no names at all.
        seed(
            serde_json::json!({"number": 7, "title": "issue 7", "content": "",
            "metadata": {}, "status": "Todo", "state": ["OPEN"], "reason": null,
            "parent": null}),
        ),
        seed(
            serde_json::json!({"number": 7, "title": "issue 7", "content": "",
            "metadata": {}, "status": "Todo", "state": "OPEN", "reason": null,
            "parent": {"id": "plan"}}),
        ),
        // Blocked by something that is no list of the seed's other issues: a
        // bare name, a mapping, an issue the seed does not hold, and itself.
        seed(
            serde_json::json!({"number": 7, "title": "issue 7", "content": "",
            "metadata": {}, "status": "Todo", "state": "OPEN", "reason": null,
            "parent": null, "blocked_by": "seven"}),
        ),
        serde_json::json!({"repository": "owner/service", "options": ["Todo"],
            "issues": {"seven": issue("OPEN", None),
                "eight": {"number": 8, "title": "issue 8", "content": "", "metadata": {},
                    "status": "Todo", "state": "OPEN", "reason": null, "parent": null,
                    "blocked_by": {"seven": true}}}}),
        seed(
            serde_json::json!({"number": 7, "title": "issue 7", "content": "",
            "metadata": {}, "status": "Todo", "state": "OPEN", "reason": null,
            "parent": null, "blocked_by": ["elsewhere"]}),
        ),
        seed(
            serde_json::json!({"number": 7, "title": "issue 7", "content": "",
            "metadata": {}, "status": "Todo", "state": "OPEN", "reason": null,
            "parent": null, "blocked_by": ["seven"]}),
        ),
        // A seed that is not JSON at all.
        Value::String("{not json".to_owned()),
    ] {
        let dir = tempfile::tempdir().expect("board directory");
        let path = dir.path().join("seed.json");
        let written = match &refused {
            Value::String(text) => text.clone(),
            seed => seed.to_string(),
        };
        std::fs::write(&path, written).expect("the seed");
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

    // The same seed made answerable is served as seeded.
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

/// `query` with `variables`, as the remote plugin sends it: authorized, to the
/// board's one route. The status and the answer.
fn graphql(board: &GitHubBoard, query: &str, variables: &Value) -> (u16, Value) {
    use std::io::Write;
    let address = board.url.strip_prefix("http://").expect("HTTP URL");
    let body = serde_json::json!({"query": query, "variables": variables}).to_string();
    let mut stream = std::net::TcpStream::connect(address).expect("reach the board");
    write!(
        stream,
        "POST /graphql HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\nAuthorization: Bearer \
         {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        board.token,
        body.len()
    )
    .expect("send the request");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read the answer");
    let (head, answer) = raw.split_once("\r\n\r\n").expect("an HTTP answer");
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    (status, serde_json::from_str(answer).expect("a JSON answer"))
}

#[test]
fn the_board_refuses_a_sub_issue_that_would_become_its_own_ancestor() {
    let dir = tempfile::tempdir().expect("board workspace");
    let board = GitHubBoard::start(dir.path());
    let before = board.state();
    assert_eq!(before["issues"]["approve"]["parent"], "plan");
    // The plan beneath its own approval: a cycle GitHub refuses, and one that
    // would never finish expanding were it held.
    let (status, answer) = graphql(
        &board,
        "mutation($input: AddSubIssueInput!) { addSubIssue(input: $input) { issue { id } } }",
        &serde_json::json!({"input": {"issueId": "approve", "subIssueId": "plan"}}),
    );
    assert_eq!(status, 400, "{answer}");
    assert_eq!(
        answer["errors"][0]["message"],
        "addSubIssue would make an issue its own ancestor"
    );
    assert_eq!(board.state()["issues"], before["issues"], "nothing moved");
    // An issue a sub-issue of itself is refused as it always was.
    let (status, _) = graphql(
        &board,
        "mutation($input: AddSubIssueInput!) { addSubIssue(input: $input) { issue { id } } }",
        &serde_json::json!({"input": {"issueId": "plan", "subIssueId": "plan"}}),
    );
    assert_eq!(status, 400);
    // And a parent that makes no cycle is held: the plan stays the root.
    let (status, answer) = graphql(
        &board,
        "mutation($input: AddSubIssueInput!) { addSubIssue(input: $input) { issue { id } } }",
        &serde_json::json!({"input": {"issueId": "plan", "subIssueId": "approve"}}),
    );
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["data"]["addSubIssue"]["subIssue"]["id"], "approve");
    assert_eq!(board.state()["issues"]["approve"]["parent"], "plan");
}
