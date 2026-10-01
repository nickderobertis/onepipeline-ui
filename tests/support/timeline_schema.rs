//! The fields a timeline schema added to an event, shared by the journey that
//! strips them and the contract test that holds them to `docs/contract.md`.

/// The fields a timeline schema added to an event, with the schema that added
/// each.
///
/// `docs/contract.md` declares every timeline schema bump additive: a new
/// schema serves new fields on the events it names, and every other span and
/// event is byte-for-byte what the schema before it served. This list is that
/// declaration read back, so a bump appends its own entry here, and
/// `tests/contract.rs` fails when an entry names a field the paragraph for its
/// schema does not.
pub const TIMELINE_EVENT_ADDITIONS: &[(u64, &str)] = &[(11, "review")];
