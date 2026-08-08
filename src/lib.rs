//! The `onepipeline-ui` read API, as a Rust interface.
//!
//! [`docs/contract.md`](https://github.com/nickderobertis/onepipeline-ui/blob/main/docs/contract.md)
//! is the source of truth for the HTTP surface; everything here is its Rust
//! rendering. This crate currently lands that rendering **only** — the contract
//! types, the route table, the query surface, the error contract, the
//! [`ReadApi`](api::ReadApi) trait an axum server will be built over, and the
//! CLI argument surface. No request is served yet and `onepipeline-ui serve`
//! refuses with a "not implemented" error; `tests/contract.rs` holds the types
//! to the contract text in the meantime.
//!
//! Payloads are carried as [`serde_json::Value`] on purpose. Anything the API
//! computes that is presentation-worthy lands in the onepipeline SDK/CLI first,
//! so the typed records arrive with that dependency rather than being invented
//! here; what this crate owns, and what the fixtures pin, is the envelope.

#![deny(missing_docs)]

pub mod api;
pub mod cli;
pub mod contract;
pub mod error;

pub use error::ApiError;
