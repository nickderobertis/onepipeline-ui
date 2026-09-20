//! The browser view, served beside the read API when `serve --ui` asks for it.
//!
//! The view — the DAG Observatory `apps/dag-ui` builds and the `onepipeline-ui`
//! npm package ships — asks for `/api/v2/…` and `/healthz` relative to whatever
//! origin served it and declares no API host, so a browser needs it and the
//! API behind **one** origin. Before this, a consumer wrote a same-origin proxy
//! for that; now the one server answers both, split by path exactly as that
//! proxy split them: the API's prefixes are the API's, and every other path is
//! the view's — the file at that path when the bundle has one, and its
//! `index.html` when it does not, so a deep link the app's router owns opens
//! rather than 404s.
//!
//! What is served is either the bundle built into this binary — `build.rs`
//! embeds `apps/dag-ui/dist` at build time, so a host that installed the binary
//! alone has the view of the same release — or, with `--ui-dist DIR`, a
//! directory on disk, which is how the view is developed against a real runs
//! root and the only way to serve a bundle of another version. A binary built
//! without the bundle refuses `--ui` naming what is missing rather than serving
//! an empty page.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use axum::body::Bytes;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

/// One file of the view built into this binary.
#[derive(Clone, Copy)]
pub struct EmbeddedFile {
    /// Its path under the bundle, `/`-separated, as a browser asks for it
    /// without the leading slash: `index.html`, `assets/index-abc123.js`.
    pub path: &'static str,
    /// Its bytes.
    pub bytes: &'static [u8],
}

/// The path and the size, never the bytes: a minified script is not a thing
/// to print into a panic message.
impl std::fmt::Debug for EmbeddedFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({} bytes)", self.path, self.bytes.len())
    }
}

// `EMBEDDED`: the table `build.rs` wrote at build time — `Some` of every file
// under `apps/dag-ui/dist`, or `None` when nothing had built it.
include!(concat!(env!("OUT_DIR"), "/embedded_ui.rs"));

/// The file a bundle is entered through, and the one every path the bundle
/// has no file for is answered with.
pub const INDEX: &str = "index.html";

/// Whether `path` is one the read API owns, and so never the view's.
///
/// The split the consumer's proxy specified: `/healthz`, and everything under
/// `/api`. Held as path segments rather than as a string prefix so the view
/// can own a path that merely *begins* with those letters — no such path
/// exists in the bundle today, and none should be answered by the API if one
/// did.
#[must_use]
pub fn is_api_path(path: &str) -> bool {
    path == crate::contract::routes::HEALTHZ
        || path == API_PREFIX
        || path.starts_with(&format!("{API_PREFIX}/"))
}

/// The path every API route but `/healthz` is under.
const API_PREFIX: &str = "/api";

/// A directory holding a built view, checked for its `index.html`.
///
/// The check is the one the server would otherwise fail on the first request:
/// a directory that exists but was never built into, or a path that is not a
/// directory, is a usage error at the command line rather than a view that
/// opens as a blank page. The CLI and a configuration file both construct it
/// the same way, so neither can carry a directory the other would reject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "PathBuf", into = "PathBuf")]
pub struct UiDist(PathBuf);

impl UiDist {
    /// The directory, as a path.
    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

impl TryFrom<PathBuf> for UiDist {
    type Error = String;

    fn try_from(path: PathBuf) -> Result<Self, Self::Error> {
        if path.join(INDEX).is_file() {
            Ok(Self(path))
        } else {
            Err(format!(
                "{} holds no built browser view: it has no {INDEX}",
                path.display()
            ))
        }
    }
}

impl FromStr for UiDist {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(PathBuf::from(value))
    }
}

impl From<UiDist> for PathBuf {
    fn from(value: UiDist) -> Self {
        value.0
    }
}

/// What `--ui` serves at every path the API does not own.
#[derive(Debug, Clone)]
pub enum View {
    /// The bundle built into this binary.
    Embedded(&'static [EmbeddedFile]),
    /// A bundle on disk, read per request so a rebuild reaches a browser
    /// without a restart.
    Directory(UiDist),
}

impl View {
    /// The view `serve` was asked for, or `None` when it was not asked for one.
    ///
    /// `embedded` is what this build carries — [`EMBEDDED`] — and is a
    /// parameter so the refusal can be driven for a build that carries nothing
    /// without compiling one.
    ///
    /// # Errors
    ///
    /// When `--ui` was asked for, no `--ui-dist` names a bundle, and this
    /// binary was built without one: the refusal names what is missing and the
    /// two ways to a view, and `main` exits with [`crate::cli::EXIT_SOFTWARE`]
    /// on it — the command parsed and this process cannot carry it out.
    pub fn resolve(
        ui: bool,
        dist: Option<&UiDist>,
        embedded: Option<&'static [EmbeddedFile]>,
    ) -> Result<Option<Self>, String> {
        if !ui {
            return Ok(None);
        }
        if let Some(dist) = dist {
            return Ok(Some(Self::Directory(dist.clone())));
        }
        match embedded {
            Some(files) => Ok(Some(Self::Embedded(files))),
            None => Err(
                "this build carries no browser view: it was built without the bundle at \
                 apps/dag-ui/dist, which the prebuilt distributions (PyPI, npm, the GitHub \
                 Release archives) embed and a build from source embeds only once `just build` \
                 has produced it"
                    .to_owned(),
            ),
        }
    }

    /// What is being served, for the line the server announces itself with.
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Embedded(_) => "the browser view built into this binary".to_owned(),
            Self::Directory(dist) => format!("the browser view at {}", dist.as_path().display()),
        }
    }

    /// Answer a request for `path` — a request URI's path, leading slash and all.
    ///
    /// The file at that path when the bundle has one, and `index.html` when it
    /// does not: the app is a single-page one, so an unknown path is a route it
    /// owns rather than a file it lacks. The disk variant is read on a blocking
    /// worker, as every other read this server makes is.
    pub async fn answer(&self, path: &str) -> Response {
        let relative = path.trim_start_matches('/').to_owned();
        match self {
            Self::Embedded(files) => {
                let served = files
                    .iter()
                    .find(|file| file.path == relative)
                    .or_else(|| files.iter().find(|file| file.path == INDEX));
                match served {
                    Some(file) => serve(file.path, Bytes::from_static(file.bytes)),
                    // A bundle with no index would have been refused at build
                    // time; the branch exists so a table nothing checked cannot
                    // be a panic in a handler.
                    None => unavailable(INDEX),
                }
            }
            Self::Directory(dist) => {
                let root = dist.as_path().to_path_buf();
                let read = tokio::task::spawn_blocking(move || read_within(&root, &relative)).await;
                match read {
                    Ok(Some((name, bytes))) => serve(&name, Bytes::from(bytes)),
                    Ok(None) | Err(_) => unavailable(INDEX),
                }
            }
        }
    }
}

/// The file at `relative` under `root`, or `root`'s index when there is none —
/// and `None` only when that index has gone since the directory was checked.
///
/// A path is answered from disk only when every segment is a plain name: an
/// empty one, `.`, `..`, or anything carrying a separator of its own is not a
/// file the bundle has, so it is the index, and a request cannot climb out of
/// the directory it was told to serve.
fn read_within(root: &Path, relative: &str) -> Option<(String, Vec<u8>)> {
    let plain = !relative.is_empty()
        && relative.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment.contains(['\\', '\0'])
        });
    if plain {
        let candidate = root.join(relative);
        if candidate.is_file() {
            if let Ok(bytes) = fs::read(&candidate) {
                return Some((relative.to_owned(), bytes));
            }
        }
    }
    fs::read(root.join(INDEX))
        .ok()
        .map(|bytes| (INDEX.to_owned(), bytes))
}

/// `bytes` as the file named `path`, typed by its extension.
///
/// Vite emits every hashed file under `assets/`, so those are immutable for as
/// long as a browser cares to keep them; everything else — the index above all,
/// which names the hashes of the current build — is revalidated on every load,
/// so a browser left open across an upgrade does not keep a page naming assets
/// the new binary no longer has.
fn serve(path: &str, bytes: Bytes) -> Response {
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type(path)),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        bytes,
    )
        .into_response()
}

/// The view's entry point has gone since the directory it is in was checked:
/// said as what it is, since there is no page to fall back to.
fn unavailable(what: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        )],
        format!("the browser view has no {what} to serve"),
    )
        .into_response()
}

/// The media type a browser needs for a file, by its extension.
///
/// The types Vite emits and the handful a bundle carries beside them; anything
/// else is bytes, which a browser downloads rather than misreads.
fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map" | "webmanifest") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
