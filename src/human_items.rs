//! The human-item routes: the engine's `onepipeline::human_items` runtime,
//! served over the host's own journal.
//!
//! Nothing here is a second implementation of the lifecycle. Every query is
//! the engine's `HumanItems::query` or `show` and every write its `apply` — the
//! calls `onepipeline human-items` makes — over the journal the engine keeps
//! beneath the runs root (`onepipeline::human_items::JOURNAL_PATH`), under the
//! effective configuration the engine loads for the directory this server was
//! started in. Persistence, ordering, blocked-step derivation, bus delivery to
//! the owning session's watch, approval authorities and a run's end retiring
//! its holds are all the engine's. What this module owns is what the engine's
//! store does not: the acting session as the actor of every write, and the
//! ownership rule `stop` keeps — an item's content and its writes belong to
//! the session that raised it.
//!
//! A host whose effective configuration does not enable human items is served
//! the engine's own `unavailable` refusal on every route.

use std::path::{Path, PathBuf};

use onepipeline::human_items::{
    HumanItemAction, HumanItemDetail, HumanItemFilter, HumanItemInput, HumanItemReceipt,
    HumanItemRefusal, HumanItemState, HumanItemView, HumanItems as Engine,
};
use serde::{Deserialize, Serialize};

use crate::cli::SessionId;
use crate::contract::HumanItemId;
use crate::error::ApiError;

/// The body of `GET /api/human-items`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HumanItemList {
    /// The matching items, in the engine's order: blocking first, then
    /// urgent, high, medium and low, then by when and which.
    pub items: Vec<HumanItemView>,
}

/// What the human-item routes read and act on: the engine's store under one
/// runs root, configured from one directory.
///
/// The store is opened for every request rather than once, so a configuration
/// enabled, disabled or edited while the server runs is the one the next
/// request acts under — exactly as each `onepipeline human-items` invocation
/// reads it afresh. The engine serializes writers under its journal's own
/// append lock, so this server and any CLI writing the same journal never
/// interleave.
#[derive(Debug, Clone)]
pub(crate) struct HumanItems {
    root: PathBuf,
    dir: PathBuf,
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
    /// The routes over the journal beneath `root`, configured from `dir`.
    pub(crate) fn live(root: &Path, dir: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            dir: dir.to_path_buf(),
        }
    }

    fn engine(&self) -> Result<Engine, ApiError> {
        Engine::open(&self.root, &self.dir).map_err(refusal)
    }

    /// Every item `session` may read that `filter` selects, in the engine's order.
    pub(crate) fn list(
        &self,
        session: Option<&SessionId>,
        filter: &HumanItemFilter,
    ) -> Result<Vec<HumanItemView>, ApiError> {
        Ok(self
            .engine()?
            .query(filter)
            .map_err(refusal)?
            .into_iter()
            .filter(|view| owns(session, &view.item.owner.session))
            .collect())
    }

    /// One item and every step it blocks, as `human-items show --json` serves it.
    pub(crate) fn detail(
        &self,
        session: Option<&SessionId>,
        id: &HumanItemId,
    ) -> Result<HumanItemDetail, ApiError> {
        readable(&self.engine()?, session, id)
    }

    /// Raise an item owned by `session`.
    pub(crate) fn raise(
        &self,
        session: Option<&SessionId>,
        input: HumanItemInput,
    ) -> Result<HumanItemReceipt, ApiError> {
        // A host with human items disabled refuses a raise as it refuses every
        // other human-item route, before any ownership is judged.
        let engine = self.engine()?;
        if !owns(session, &input.owner.session) {
            return Err(ApiError::HumanItemNotOwner(
                "a human item is raised only as its owner: owner.session must be the session \
                 this server acts as"
                    .to_owned(),
            ));
        }
        engine.apply(HumanItemAction::Raise(input)).map_err(refusal)
    }

    /// Make `act` on item `id` as `session`.
    ///
    /// Ownership is judged on the journal's state before the write; the owner
    /// of an item never changes, so the engine's own serialized write cannot
    /// land on an item whose owner differs from the one judged.
    pub(crate) fn act(
        &self,
        session: Option<&SessionId>,
        id: &HumanItemId,
        act: Act,
    ) -> Result<HumanItemReceipt, ApiError> {
        let engine = self.engine()?;
        readable(&engine, session, id)?;
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
        engine.apply(action).map_err(refusal)
    }
}

/// Whether `session` holds the authority over an item `owner` raised: the
/// ownership rule `stop` keeps, under which an unattributed server owns nothing.
fn owns(session: Option<&SessionId>, owner: &str) -> bool {
    session.is_some_and(|session| session.as_str() == owner)
}

/// Item `id` and every step it blocks, if `session` may read it.
fn readable(
    engine: &Engine,
    session: Option<&SessionId>,
    id: &HumanItemId,
) -> Result<HumanItemDetail, ApiError> {
    let detail = match engine.show(id.as_str()) {
        Ok(detail) => detail,
        // The engine answers an id it holds no item for with the same
        // `Conflict` a store it cannot read is answered with, so which one this
        // is is asked of the journal itself: an id no item in any state carries
        // is the error contract's `404`, never a conflict.
        Err(refused) => {
            return Err(if held(engine, id)? {
                refusal(refused)
            } else {
                ApiError::HumanItemNotFound(id.clone())
            });
        }
    };
    if !owns(session, &detail.item.owner.session) {
        return Err(ApiError::HumanItemNotOwner(format!(
            "human item {} belongs to another session; its content and its actions are that \
             session's",
            id.as_str()
        )));
    }
    Ok(detail)
}

/// Whether any item, in any state and of any owner, carries `id`.
fn held(engine: &Engine, id: &HumanItemId) -> Result<bool, ApiError> {
    for state in [
        HumanItemState::Open,
        HumanItemState::Answered,
        HumanItemState::Completed,
        HumanItemState::Dismissed,
    ] {
        let filter = HumanItemFilter {
            state: Some(state),
            ..HumanItemFilter::default()
        };
        if engine
            .query(&filter)
            .map_err(refusal)?
            .iter()
            .any(|view| view.item.id == id.as_str())
        {
            return Ok(true);
        }
    }
    Ok(false)
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
