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
/// schema does not. A field added inside an object an event already carried is
/// named by its dotted path, as `redirection.turn` is.
pub const TIMELINE_EVENT_ADDITIONS: &[(u64, &str)] = &[
    (11, "review"),
    (12, "redirection.turn"),
    (13, "stream"),
    (13, "seq"),
    (13, "journal_order"),
    (13, "record_id"),
    (13, "dispatch_id"),
    (13, "dispatch_group"),
    (13, "persona"),
    (13, "fields"),
    (14, "description"),
    (14, "tool"),
    (15, "review.requirement"),
    (15, "review.url"),
    (16, "surface_id"),
    (16, "correlation"),
    (16, "surface_state"),
];

/// The fields a timeline schema added to the events of one kind alone, with the
/// schema that added each: read as [`TIMELINE_EVENT_ADDITIONS`] is, and stripped
/// from that kind's events only, because the field is one other kinds already
/// carried. Schema 17 gives an `edit-rejected` the `reference` its kept refusal
/// is opened by.
pub const TIMELINE_KIND_ADDITIONS: &[(u64, &str, &str)] = &[(17, "edit-rejected", "reference")];

/// The timeline schema whose `fields` are every payload key under its wire key,
/// where the schemas before it served a selection under English labels: the one
/// event field a bump re-keyed rather than added to.
pub const WIRE_KEYED_FIELDS: u64 = 16;
