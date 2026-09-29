//! The `onepipeline-ui` read API: an axum server wrapping the onepipeline SDK.
//!
//! [`docs/contract.md`](https://github.com/nickderobertis/onepipeline-ui/blob/main/docs/contract.md)
//! is the source of truth for the HTTP surface; everything here is its Rust
//! rendering. [`contract`] is the wire vocabulary — routes, envelope,
//! identifiers, queries and bodies — [`api::RunApi`] is the trait one method
//! per route, [`store::RunStore`] implements it over a runs root through the
//! SDK's [`views`](onepipeline::views) and [`verbs`](onepipeline::verbs), and
//! [`server`] is the axum router that serves it — and, asked to with `--ui`,
//! the browser view [`ui`] holds beside it. Every route after the read
//! surface the browser view was copied against is a post-launch CLI verb,
//! wrapped: a thin call into `onepipeline::verbs` with this crate's envelope
//! around the engine's own result, and the server never runs the `onepipeline`
//! binary for anything. [`liveness`] is the SDK's own listing reading, called;
//! its header says where that call looks. `tests/contract.rs` holds the types
//! to the contract text and `tests/e2e/` drives the compiled binary over real
//! HTTP.
//!
//! Payloads are carried as [`serde_json::Value`] on purpose. Anything the API
//! computes that is presentation-worthy lands in the onepipeline SDK/CLI first,
//! so the typed records arrive from there rather than being invented here; what
//! this crate owns, and what the fixtures pin, is the envelope. [`payload`] is
//! the projection from the SDK's records onto the wire, and AGENTS.md lists
//! every derivation in it that is proposed for the SDK. [`telemetry`] is the
//! seam onto the SDK's own telemetry document — the fold it publishes and the
//! one its summary carries — held to the producer's contract before a timing
//! is served, and never folded a second time here.
//!
//! This crate's public surface follows `onepipeline`'s version, because parts
//! of it are made of that crate's types: [`ApiError::from_engine`] takes an
//! [`onepipeline::Error`], [`filter::EventFilter::to_engine`] returns an
//! [`onepipeline::filter::EventFilter`], and [`telemetry::of_run`] reads an
//! [`onepipeline::views::RunView`]. `Cargo.toml` pins the engine exactly, so a
//! release that moves that pin across a `0.x` minor makes callers of those
//! items recompile against the new engine. That is a breaking change of this
//! crate, whatever its own signatures show: moving to `onepipeline` 0.53.0
//! left [`ApiError::from_engine`] spelled exactly as before, and a caller
//! still holding a 0.52 [`onepipeline::Error`] could no longer pass it, which
//! is why no reading of this crate's API alone can see such a break.

#![deny(missing_docs)]

pub mod api;
pub mod cli;
pub mod contract;
pub mod error;
pub mod filter;
pub mod liveness;
pub mod payload;
pub mod server;
pub mod store;
pub mod telemetry;
pub mod ui;

pub use error::ApiError;
