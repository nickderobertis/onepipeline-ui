//! A loopback GitHub board, at the remote plugin's real HTTP boundary.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use serde_json::Value;

/// Owns the endpoint process and the directory containing its current board state.
pub struct GitHubBoard {
    child: Child,
    dir: PathBuf,
    pub url: String,
}

impl GitHubBoard {
    pub fn start(workspace: &Path) -> Self {
        let dir = workspace.join("github-board");
        std::fs::create_dir_all(&dir).expect("board directory");
        let child = Command::new("python3")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/github_board.py"))
            .arg(&dir)
            .spawn()
            .expect("the loopback board starts");
        // Own the child before waiting, so even a startup failure reaps it.
        let mut board = Self {
            child,
            dir,
            url: String::new(),
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
