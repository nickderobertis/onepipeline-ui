//! The `onepipeline-ui` read API: an axum server wrapping the onepipeline SDK.
//!
//! [`docs/contract.md`](https://github.com/nickderobertis/onepipeline-ui/blob/main/docs/contract.md)
//! is the source of truth for the HTTP surface; everything here is its Rust
//! rendering. [`contract`] is the wire vocabulary — routes, envelope,
//! identifiers, queries — [`api::ReadApi`] is the trait one method per route,
//! [`store::RunStore`] implements it over a runs root through the SDK's
//! [`views`](onepipeline::views), and [`server`] is the axum router that serves
//! it. [`liveness`] is the one reading in here that restates one of the SDK's,
//! because the bounded document a listing reads carries that reading's inputs
//! and the SDK publishes no entry point that takes them; its own header names
//! the check that fails when the two drift apart. `tests/contract.rs` holds the types to the contract text and
//! `tests/e2e/` drives the compiled binary over real HTTP.
//!
//! Payloads are carried as [`serde_json::Value`] on purpose. Anything the API
//! computes that is presentation-worthy lands in the onepipeline SDK/CLI first,
//! so the typed records arrive from there rather than being invented here; what
//! this crate owns, and what the fixtures pin, is the envelope. [`payload`] is
//! the projection from the SDK's records onto the wire, and AGENTS.md lists
//! every derivation in it that is proposed for the SDK. [`telemetry`] is the
//! seam onto the SDK's own telemetry document, which it aggregates and this
//! crate reads rather than folding a run's clock a second time.

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

pub use error::ApiError;
