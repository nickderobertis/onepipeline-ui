//! The reader this repository's own machinery takes `release-targets.toml`
//! through.
//!
//! **The schema is not this repository's, and neither is judging conformance to
//! it.** It is defined once — in `onevcs`'s `docs/contract.md`, enforced by that
//! crate's own reader — because six repositories write one of these documents and
//! a consumer parses all six. Restating it here would be a second definition of a
//! contract that has one source, and nothing in an offline gate could hold the
//! copy to the original. So this reads what *this* repository reads out of its own
//! declaration and refuses what would leave one of its own callers with no answer,
//! and nothing beyond that: how long a sentence may be, how a path may be spelled,
//! and which keys a later schema adds are the canonical reader's to have an
//! opinion on. When a release of `onevcs` carries
//! `validate_release_declaration`, this becomes a call to it.
//!
//! What it does refuse is what its own callers cannot proceed past: a field
//! `tests/packaging.rs` or `tests/e2e/release_probe.rs` reads and the document does
//! not carry, an identifier the probe could not be handed, and a document saying
//! two things about one artifact — two targets under one short name or one
//! identifier, an identifier that is both covered and a target, an artifact both
//! retired and published. Each of those was already a refusal this repository made
//! about the JSON document this one replaced.

#![allow(dead_code)] // Each test binary uses the part of the reader it needs.

use std::path::Path;

use serde::Deserialize;

/// The one name a repository's release declaration is found under, at its root.
///
/// Fixed rather than configured: a consumer reads this file across repositories it
/// does not own, and a location it would have to be told is one it cannot discover.
pub const FILE: &str = "release-targets.toml";

/// The schema version this reader was written against.
///
/// A document declaring an older one is a different shape and is refused. A later
/// one is read as this shape with whatever it names beyond it ignored — the
/// leniency the document promises a consumer one release behind, and the reason
/// nothing here refuses a key it does not know.
pub const SCHEMA_VERSION: i64 = 1;

/// What one repository publishes, as its own `release-targets.toml` declares it.
///
/// The order of [`targets`](Self::targets) is the document's own — the schema says
/// publication order — and reading preserves it.
// llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] the one source
// is `onevcs`'s reader and this is not permitted to become a second one, which is
// why the fields below are only those a caller in this repository reads and carry
// none of the schema's own opinions about them. It cannot yet *be* that source:
// `validate_release_declaration` landed on `onevcs`'s default branch and no
// release carries it, and this crate's `onevcs` dev-dependency is pinned at the
// major `onepipeline` resolves so that the tree holds one copy of that library.
// A drift gate is the other way the rule can be satisfied and is not available
// either: the canonical reader is reachable only over the network, and this
// repository's gate is deterministic and offline by construction (AGENTS.md).
// The move is a one-line call, not a rewrite: when a release carries the reader,
// `validate` below becomes it and this block goes.
#[derive(Debug, Deserialize)]
pub struct Declaration {
    /// The schema this document is written against.
    pub schema_version: i64,
    /// The script that answers what a registry currently serves for one
    /// [`DeclaredTarget::id`]. Optional: a repository whose targets are answered
    /// some other way declares none.
    #[serde(default)]
    pub probe: Option<String>,
    /// The consumable artifacts this repository publishes, in publication order.
    #[serde(rename = "target", default)]
    pub targets: Vec<DeclaredTarget>,
    /// What this repository once published and does not any more.
    #[serde(rename = "retired", default)]
    pub retired: Vec<RetiredArtifact>,
}

/// One consumable artifact: something a dependent names in order to depend on it.
#[derive(Debug, Deserialize)]
pub struct DeclaredTarget {
    /// The registry-qualified identifier a registry serves this artifact under.
    pub id: RegistryId,
    /// The short name this target is waited on by — what a host document and a
    /// consumer's plan call it. It cannot be derived from [`id`](Self::id).
    pub name: TargetName,
    /// One sentence saying what a dependent gets.
    pub what: Prose,
    /// The workflow and job that publish it, and the manifest its name and version
    /// come from.
    pub published_by: Prose,
    /// The manifest this target's version is read from. That this repository
    /// carries the file it names is `tests/packaging.rs`'s assertion, which is a
    /// stronger thing to ask of this document than any rule about how a path may
    /// be spelled.
    #[serde(default)]
    pub manifest: Option<String>,
    /// Identifiers this target's release also ships, which are not targets of their
    /// own because nothing depends on one by name.
    #[serde(default)]
    pub covers: Vec<RegistryId>,
}

/// Something this repository once published and does not publish again — recorded
/// rather than deleted, so a consumer that still names it is told it is gone.
#[derive(Debug, Deserialize)]
pub struct RetiredArtifact {
    /// The identifier that is no longer published.
    pub id: RegistryId,
    /// Why it is not published any more, and what replaced it if anything did.
    pub why: Prose,
}

/// A registry-qualified identifier, `<registry>:<name>`, as the probe is handed it.
///
/// The qualification is load-bearing: `onepipeline-ui` is this crate on crates.io
/// and the built frontend on npm, so an unqualified name is two artifacts — and
/// `scripts/release-probe.sh` refuses one, which would leave a target nobody could
/// ever be answered for. The registry half is an open vocabulary; which registries
/// *this* repository's probe reads is `tests/packaging.rs`'s question.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct RegistryId(String);

impl RegistryId {
    /// Where it is served: everything before the colon.
    pub fn registry(&self) -> &str {
        self.0.split_once(':').expect("a validated identifier").0
    }

    /// What it is served as, spelled exactly as that registry spells it.
    pub fn name(&self) -> &str {
        self.0.split_once(':').expect("a validated identifier").1
    }

    /// The identifier as a consumer passes it to a probe.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for RegistryId {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let Some((registry, name)) = value.split_once(':') else {
            return Err(format!(
                "the release-target identifier {value:?} names no registry; spell every \
                 identifier as <registry>:<name>, because one name published to two registries \
                 is two artifacts"
            ));
        };
        if registry.is_empty() || name.is_empty() {
            return Err(format!(
                "the release-target identifier {value:?} has nothing on one side of its colon; \
                 spell every identifier as <registry>:<name>"
            ));
        }
        Ok(Self(value))
    }
}

/// The short name a target is waited on by — the vocabulary a host document and a
/// plan node both name a target in, and the one a reader of this document lists
/// artifacts by.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct TargetName(String);

impl TargetName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for TargetName {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        // One word, because it is typed on a command line and matched by a host
        // document against what it calls the same target.
        if value.is_empty() || value.chars().any(char::is_whitespace) {
            return Err(format!(
                "the release target name {value:?} is not one word; it is what a host document \
                 and a consumer's plan name this target by"
            ));
        }
        Ok(Self(value))
    }
}

/// One line of operator-written text: `what`, `published_by`, and `why`.
///
/// Each is the sentence a reader of this document learns the entry from, so a blank
/// one leaves them with an identifier where they were promised a sentence.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct Prose(String);

impl Prose {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Prose {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.trim().is_empty() {
            return Err(
                "a release declaration's `what`, `published_by`, and `why` are each what a \
                 reader learns from the entry they describe, so none of them may be blank"
                    .to_owned(),
            );
        }
        Ok(Self(value))
    }
}

// llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

/// Read one release declaration's text, and answer what it declares.
///
/// `origin` is what the refusals name the document by.
pub fn validate(document: &str, origin: &str) -> Result<Declaration, String> {
    // The version is read before the shape, and refused before it: which shape a
    // document has is a fact about the schema it declares, so one this reader was
    // not written against is answered as that rather than as whichever of its
    // fields read strangely first.
    let table: toml::Table = toml::from_str(document)
        .map_err(|failure| format!("the release declaration at {origin} is not TOML: {failure}"))?;
    let Some(declared) = table
        .get("schema_version")
        .and_then(toml::Value::as_integer)
    else {
        return Err(format!(
            "the release declaration at {origin} declares no schema_version; every declaration \
             opens with `schema_version = {SCHEMA_VERSION}`, before any table"
        ));
    };
    if declared < SCHEMA_VERSION {
        return Err(format!(
            "the release declaration at {origin} declares schema_version {declared}; this reader \
             was written against schema_version {SCHEMA_VERSION} and reads it and newer"
        ));
    }
    // Deserialized from the text rather than from the table just parsed: `toml`
    // carries the line and column of every field through a string it still has, and
    // loses them through a value it does not.
    let declaration: Declaration = toml::from_str(document).map_err(|failure| {
        format!("the release declaration at {origin} is not a declaration this reads: {failure}")
    })?;
    coherent(&declaration, origin)?;
    Ok(declaration)
}

/// Refuse a declaration whose fields are each readable but which together say two
/// things about one artifact.
///
/// Each of these leaves a caller here with no answer rather than a wrong one:
/// `declared_coverage` cannot say which target accounts for an identifier two of
/// them claim, and a consumer cannot say which release it is waiting for. Each
/// refusal names the entry by its position and its identifier.
fn coherent(declaration: &Declaration, origin: &str) -> Result<(), String> {
    if declaration.targets.is_empty() {
        return Err(format!(
            "the release declaration at {origin} declares no [[target]]; a declaration that \
             names nothing says less than no declaration at all, because a consumer reading it \
             cannot tell whether this repository publishes nothing or nobody has said what it \
             publishes"
        ));
    }
    for (index, target) in declaration.targets.iter().enumerate() {
        let at = format!("[[target]] {} ({:?})", index + 1, target.id.as_str());
        let earlier = &declaration.targets[..index];
        if let Some(first) = earlier.iter().position(|other| other.name == target.name) {
            return Err(format!(
                "the release declaration at {origin} has {at} taking the short name {name:?}, \
                 which [[target]] {} already takes; the short name is what a host document and a \
                 consumer's plan name this target by, so two of them are two answers to one \
                 question",
                first + 1,
                name = target.name.as_str(),
            ));
        }
        if let Some(first) = earlier.iter().position(|other| other.id == target.id) {
            return Err(format!(
                "the release declaration at {origin} has {at} declaring the identifier \
                 [[target]] {} already declares; one artifact is one target",
                first + 1
            ));
        }
    }
    covered(declaration, origin)?;
    retired(declaration, origin)
}

/// Hold every `covers` entry to what covering means.
///
/// A covered identifier is shipped by a target's release and is *not* a target of
/// its own — that is the whole distinction the key draws — so an identifier that is
/// both is a document saying two things about one artifact, and one two targets
/// both cover is a document with no answer for which release ships it.
fn covered(declaration: &Declaration, origin: &str) -> Result<(), String> {
    let mut seen: Vec<(&RegistryId, usize)> = Vec::new();
    for (index, target) in declaration.targets.iter().enumerate() {
        let at = format!("[[target]] {} ({:?})", index + 1, target.id.as_str());
        for id in &target.covers {
            if let Some(other) = declaration
                .targets
                .iter()
                .position(|target| target.id == *id)
            {
                return Err(format!(
                    "the release declaration at {origin} has {at} covering {covered:?}, which \
                     [[target]] {} declares as a target of its own; an artifact is one or the \
                     other, because a consumer waits on a target by name and never waits on \
                     something covered",
                    other + 1,
                    covered = id.as_str()
                ));
            }
            if let Some((_, first)) = seen.iter().find(|(already, _)| *already == id) {
                return Err(format!(
                    "the release declaration at {origin} has {at} covering {covered:?}, which \
                     [[target]] {} already covers; one artifact is shipped by one release",
                    first + 1,
                    covered = id.as_str()
                ));
            }
            seen.push((id, index));
        }
    }
    Ok(())
}

/// Hold every `[[retired]]` entry to what retirement means: it is not published any
/// more, so a document that also publishes it is two answers about one artifact.
fn retired(declaration: &Declaration, origin: &str) -> Result<(), String> {
    for (index, entry) in declaration.retired.iter().enumerate() {
        let at = format!("[[retired]] {} ({:?})", index + 1, entry.id.as_str());
        if let Some(target) = declaration
            .targets
            .iter()
            .position(|target| target.id == entry.id)
        {
            return Err(format!(
                "the release declaration at {origin} has {at} retiring what [[target]] {} \
                 publishes; a retired artifact is one this repository does not publish any more",
                target + 1
            ));
        }
        if let Some(first) = declaration.retired[..index]
            .iter()
            .position(|other| other.id == entry.id)
        {
            return Err(format!(
                "the release declaration at {origin} has {at} repeating what [[retired]] {} \
                 already records",
                first + 1
            ));
        }
    }
    Ok(())
}

/// The declaration this repository carries, refused loudly if it is one no caller
/// here could act on.
pub fn declared() -> Declaration {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(FILE);
    let document = std::fs::read_to_string(&path)
        .unwrap_or_else(|failure| panic!("read {}: {failure}", path.display()));
    validate(&document, FILE).unwrap_or_else(|refusal| panic!("{refusal}"))
}
