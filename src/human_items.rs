//! The human-item routes: the engine's `onepipeline::human_items` contract,
//! served over the one adapter that release ships — its explicit sample bundle.
//!
//! Nothing here is a second implementation of the lifecycle. Every query is
//! `HumanItemSample::query` and every write is `HumanItemSample::apply`, the
//! same calls `onepipeline human-items --sample FILE` makes, over the same file:
//! the bundle is read before every request and written back after every write
//! that changed it, exactly as the CLI does, so the two read one store. What
//! this module owns is what the engine's adapter does not: the acting session
//! as the actor of every write, and the ownership rule `stop` keeps — an item's
//! content and its writes belong to the session that raised it.
//!
//! A live host serves no sample. Without `--human-items-sample` every route
//! answers the engine's own `unavailable` refusal, and the flag is refused
//! over a runs root that holds anything ([`HumanItemsSample::serving_over`]),
//! so fixture items can never appear beside real runs.

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use onepipeline::human_items::{
    HumanItemAction, HumanItemBlocked, HumanItemDetail, HumanItemFilter, HumanItemInput,
    HumanItemReceipt, HumanItemRefusal, HumanItemSample, HumanItemView,
};
use serde::{Deserialize, Serialize};

use crate::cli::{RunsRoot, SessionId};
use crate::contract::HumanItemId;
use crate::error::ApiError;

/// A human-item sample bundle this process has read and the engine accepted.
///
/// Constructed only by reading the file and decoding it as the engine's
/// `HumanItemSample`, whose decoder validates every record, count and preview —
/// so a bundle the CLI would refuse is a usage error at the command line rather
/// than a server that fails its first request. The flag and a configuration
/// file construct it the same way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "PathBuf", into = "PathBuf")]
pub struct HumanItemsSample(PathBuf);

impl HumanItemsSample {
    /// The bundle's path.
    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    /// This sample, if it may be served beside `root`.
    ///
    /// A sample is test-only configuration, and a runs root that holds anything
    /// is a host's live store: serving fixture items beside real runs would put
    /// invented work in front of an operator as if it were theirs. So the
    /// sample is served only over an empty root.
    ///
    /// # Errors
    ///
    /// When `root` holds any entry, or can no longer be read.
    pub fn serving_over(&self, root: &RunsRoot) -> Result<&Self, String> {
        let mut entries = fs::read_dir(root.as_path()).map_err(|err| {
            format!(
                "{} is not a readable directory: {}",
                root.as_path().display(),
                err.kind()
            )
        })?;
        if entries.next().is_some() {
            return Err(format!(
                "--human-items-sample serves fixture items and is refused over {}, which holds \
                 runs: a live host never serves sample data",
                root.as_path().display()
            ));
        }
        Ok(self)
    }
}

impl TryFrom<PathBuf> for HumanItemsSample {
    type Error = String;

    fn try_from(path: PathBuf) -> Result<Self, Self::Error> {
        read(&path)?;
        Ok(Self(path))
    }
}

impl FromStr for HumanItemsSample {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(PathBuf::from(value))
    }
}

impl From<HumanItemsSample> for PathBuf {
    fn from(value: HumanItemsSample) -> Self {
        value.0
    }
}

/// The bundle at `path`, as the engine decodes it.
fn read(path: &Path) -> Result<HumanItemSample, String> {
    let bytes = fs::read(path).map_err(|err| format!("{}: {}", path.display(), err.kind()))?;
    serde_json::from_slice(&bytes).map_err(|err| {
        format!(
            "{} is not a human-item sample bundle: {err}",
            path.display()
        )
    })
}

/// The body of `GET /api/human-items`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HumanItemList {
    /// The matching items, in the engine's order: blocking first, then
    /// urgent, high, medium and low, then by when and which.
    pub items: Vec<HumanItemView>,
}

/// The bundle at `path`, as a route reads it: a failure is the engine's, and
/// names no path — every message the error contract serves is safe to show.
fn served(path: &Path) -> Result<HumanItemSample, ApiError> {
    let bytes = fs::read(path).map_err(|err| {
        ApiError::Engine(format!(
            "the human-item sample bundle could not be read: {}",
            err.kind()
        ))
    })?;
    serde_json::from_slice(&bytes).map_err(|err| {
        ApiError::Engine(format!(
            "the human-item sample bundle is not one the engine accepts: {err}"
        ))
    })
}

/// What the human-item routes read and act on.
///
/// Cloned with the store that holds it; every clone shares the one lock, so
/// two writes never interleave their read and write-back of the bundle.
#[derive(Debug, Clone, Default)]
pub(crate) struct HumanItems {
    sample: Option<Arc<Sample>>,
}

#[derive(Debug)]
struct Sample {
    path: PathBuf,
    lock: Mutex<()>,
}

/// A write to one item, as its route's body carried it. The actor is never in
/// here: it is the acting session, added when the write is made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Act {
    /// Answer a question.
    Answer(String),
    /// Complete a task, with the approval reference it stored.
    Complete,
    /// Dismiss an item, with an optional reason.
    Dismiss(Option<String>),
}

impl HumanItems {
    /// The routes over `sample`.
    pub(crate) fn sample(sample: &HumanItemsSample) -> Self {
        Self {
            sample: Some(Arc::new(Sample {
                path: sample.as_path().to_path_buf(),
                lock: Mutex::new(()),
            })),
        }
    }

    /// Every item `session` may read that `filter` selects, in the engine's order.
    pub(crate) fn list(
        &self,
        session: Option<&SessionId>,
        filter: &HumanItemFilter,
    ) -> Result<Vec<HumanItemView>, ApiError> {
        self.with(|bundle| {
            Ok(bundle
                .query(filter)
                .into_iter()
                .filter(|view| owns(session, &view.item.owner.session))
                .collect())
        })
    }

    /// One item and every step it blocks, as `human-items show --json` serves it.
    pub(crate) fn detail(
        &self,
        session: Option<&SessionId>,
        id: &HumanItemId,
    ) -> Result<HumanItemDetail, ApiError> {
        self.with(|bundle| {
            let stored = readable(bundle, session, id)?;
            let blocking = stored.item.is_blocking();
            Ok(HumanItemDetail {
                item: stored.item.clone(),
                blocked: if blocking {
                    stored.blocked.clone()
                } else {
                    HumanItemBlocked {
                        total: 0,
                        plans: vec![],
                    }
                },
                nodes: if blocking {
                    stored.nodes.clone()
                } else {
                    vec![]
                },
            })
        })
    }

    /// Raise an item owned by `session`.
    pub(crate) fn raise(
        &self,
        session: Option<&SessionId>,
        input: HumanItemInput,
    ) -> Result<HumanItemReceipt, ApiError> {
        // A host serving no sample refuses a raise as it refuses every other
        // human-item route, before any ownership is judged.
        self.adapter()?;
        if !owns(session, &input.owner.session) {
            return Err(ApiError::HumanItemNotOwner(
                "a human item is raised only as its owner: owner.session must be the session \
                 this server acts as"
                    .to_owned(),
            ));
        }
        self.apply(HumanItemAction::Raise(input))
    }

    /// Make `act` on item `id` as `session`.
    pub(crate) fn act(
        &self,
        session: Option<&SessionId>,
        id: &HumanItemId,
        act: Act,
    ) -> Result<HumanItemReceipt, ApiError> {
        // The ownership read and the write share one hold of the lock, so the
        // item judged is the item written.
        let sample = self.adapter()?;
        let _held = sample
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bundle = served(&sample.path)?;
        readable(&bundle, session, id)?;
        // Over HTTP a write is the user's own action through this server, so
        // the actor is the acting session and nobody is acted for: there is no
        // `on_behalf_of` in any body and no flag that sets one. A manager
        // completing on a user's behalf after that user approved in the
        // manager's chat is the CLI/runtime path's, where the manager running
        // the command supplies it (`docs/contract.md`, "Human items").
        let actor = session
            .map(SessionId::as_str)
            .unwrap_or_default()
            .to_owned();
        let id = id.as_str().to_owned();
        let action = match act {
            Act::Answer(text) => HumanItemAction::Answer {
                id,
                text,
                actor,
                on_behalf_of: None,
            },
            Act::Complete => HumanItemAction::Complete {
                id,
                actor,
                on_behalf_of: None,
            },
            Act::Dismiss(reason) => HumanItemAction::Dismiss {
                id,
                reason,
                actor,
                on_behalf_of: None,
            },
        };
        apply_to(&sample.path, &mut bundle, action)
    }

    fn apply(&self, action: HumanItemAction) -> Result<HumanItemReceipt, ApiError> {
        let sample = self.adapter()?;
        let _held = sample
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bundle = served(&sample.path)?;
        apply_to(&sample.path, &mut bundle, action)
    }

    fn with<T>(
        &self,
        read_bundle: impl FnOnce(&HumanItemSample) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let sample = self.adapter()?;
        let _held = sample
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        read_bundle(&served(&sample.path)?)
    }

    fn adapter(&self) -> Result<&Sample, ApiError> {
        self.sample
            .as_deref()
            .ok_or_else(|| refusal(HumanItemRefusal::Unavailable))
    }
}

/// Whether `session` holds the authority over an item `owner` raised: the
/// ownership rule `stop` keeps, under which an unattributed server owns nothing.
fn owns(session: Option<&SessionId>, owner: &str) -> bool {
    session.is_some_and(|session| session.as_str() == owner)
}

/// Item `id`, if `session` may read it.
fn readable<'a>(
    bundle: &'a HumanItemSample,
    session: Option<&SessionId>,
    id: &HumanItemId,
) -> Result<&'a HumanItemDetail, ApiError> {
    let stored = bundle
        .items
        .iter()
        .find(|detail| detail.item.id == id.as_str())
        .ok_or_else(|| ApiError::HumanItemNotFound(id.clone()))?;
    if !owns(session, &stored.item.owner.session) {
        return Err(ApiError::HumanItemNotOwner(format!(
            "human item {} belongs to another session; its content and its actions are that \
             session's",
            id.as_str()
        )));
    }
    Ok(stored)
}

/// `action` applied to `bundle`, written back to `path` whenever it changed the
/// bundle — a refusal included, because a design review whose document changed
/// refuses *and* dismisses the obsolete task and raises its replacement, which
/// the CLI keeps too.
fn apply_to(
    path: &Path,
    bundle: &mut HumanItemSample,
    action: HumanItemAction,
) -> Result<HumanItemReceipt, ApiError> {
    let before = bundle.clone();
    let outcome = bundle.apply(action);
    if *bundle != before {
        write(path, bundle)?;
    }
    outcome.map_err(refusal)
}

/// Write `bundle` over `path` whole, through a sibling file renamed into place,
/// so a reader never meets half of it.
fn write(path: &Path, bundle: &HumanItemSample) -> Result<(), ApiError> {
    let bytes =
        serde_json::to_vec_pretty(bundle).map_err(|err| ApiError::Engine(err.to_string()))?;
    let mut staged = path.as_os_str().to_owned();
    staged.push(".writing");
    let staged = PathBuf::from(staged);
    fs::write(&staged, bytes)
        .and_then(|()| fs::rename(&staged, path))
        .map_err(|err| {
            ApiError::Engine(format!("the sample bundle was not written: {}", err.kind()))
        })
}

/// The engine's typed refusal, as the error contract serves it.
fn refusal(refusal: HumanItemRefusal) -> ApiError {
    match refusal {
        unavailable @ HumanItemRefusal::Unavailable => {
            ApiError::HumanItemsUnavailable(unavailable.to_string())
        }
        HumanItemRefusal::Conflict { reason } => ApiError::HumanItemConflict(reason),
    }
}
