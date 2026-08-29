//! The canonical release-target schema, as this repository's own boundary check
//! on the `release-targets.toml` it carries.
//!
//! The schema is **not this repository's**. It is defined once, in `onevcs`'s
//! `docs/contract.md`, and enforced by that crate's own reader — six repositories
//! write a document against it, and a shape any one of them was free to amend
//! would be six shapes again, which is the divergence this document exists to end.
//! What lives here is the check at this repository's boundary: schema version 1,
//! spelled the way that contract spells it, so a declaration this repository could
//! not have meant fails in this repository's gate rather than in a consumer that
//! read it.
//!
//! It is a second implementation of that schema and deliberately not a second
//! definition of it: every refusal below is one the contract names, in the order
//! it names them. Linking `onevcs`'s reader instead would be strictly better and
//! is not yet possible — the reader landed on that repository's default branch and
//! is not on crates.io, and this crate's dev-dependency on `onevcs` is held at the
//! major `onepipeline` resolves. When a release carries it, this module becomes a
//! call to `onevcs::validate_release_declaration`.
//!
//! Refusing well is most of the value: a declaration is written once and then read
//! by machinery, so every refusal names the document and what in it is wrong.

#![allow(dead_code)] // Each test binary uses the part of the reader it needs.

use std::path::Path;

use serde::Deserialize;

/// The one name a repository's release declaration is found under, at its root.
///
/// Fixed rather than configured: a consumer reads this file across repositories it
/// does not own, and a location it would have to be told is one it cannot discover.
pub const FILE: &str = "release-targets.toml";

/// The schema version this check reads, and the oldest it accepts.
pub const SCHEMA_VERSION: i64 = 1;

/// How long a registry-qualified identifier may be, so a refusal quoting one is
/// still a sentence.
const MAX_IDENTIFIER: usize = 128;

/// How long the prose fields may be. `what` is one sentence and `published_by`
/// names a workflow, a job and a manifest; both render on one line.
const MAX_PROSE: usize = 400;

/// How long a target's short name may be.
const MAX_TARGET_NAME: usize = 64;

/// What one repository publishes, as its own `release-targets.toml` declares it.
///
/// The order of [`targets`](Self::targets) is the document's own — the schema says
/// publication order — and reading preserves it.
#[derive(Debug, Deserialize)]
pub struct Declaration {
    /// The schema this document is written against.
    pub schema_version: i64,
    /// The script that answers what a registry currently serves for one
    /// [`DeclaredTarget::id`]. Optional: a repository whose targets are answered
    /// some other way declares none.
    #[serde(default)]
    pub probe: Option<RepositoryPath>,
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
    /// The manifest this target's version is read from.
    #[serde(default)]
    pub manifest: Option<RepositoryPath>,
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

/// A registry-qualified identifier, `<registry>:<name>`.
///
/// The qualification is load-bearing: `onepipeline-ui` is this crate on crates.io
/// and the built frontend on npm, so an unqualified name is two artifacts. The
/// registry half is an open vocabulary — what is closed is the shape.
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
        if value.len() > MAX_IDENTIFIER {
            return Err(format!(
                "the release-target identifier {value:?} is longer than {MAX_IDENTIFIER} characters"
            ));
        }
        let Some((registry, name)) = value.split_once(':') else {
            return Err(format!(
                "the release-target identifier {value:?} names no registry; spell every \
                 identifier as <registry>:<name>, because one name published to two registries \
                 is two artifacts"
            ));
        };
        if registry.is_empty()
            || !registry
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!(
                "the release-target identifier {value:?} names the registry {registry:?}, which \
                 is not one word of lowercase letters, digits, and '-'"
            ));
        }
        // The name becomes a path segment of a registry URL wherever one is asked,
        // so it is held to the alphabet crates.io, PyPI and npm all serve rather
        // than to whichever of them a reader happens to ask first.
        if !name
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@' | '/'))
        {
            return Err(format!(
                "the release-target identifier {value:?} names {name:?}, which is not a name a \
                 registry serves; spell the name exactly as its registry does"
            ));
        }
        Ok(Self(value))
    }
}

/// The short name a target is waited on by — the vocabulary a host document and a
/// plan node both name a target in.
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
        if value.len() > MAX_TARGET_NAME {
            return Err(format!(
                "the release target name {value:?} is longer than {MAX_TARGET_NAME} characters"
            ));
        }
        if !value
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        {
            return Err(format!(
                "the release target name {value:?} must start with a letter or a digit"
            ));
        }
        if !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(format!(
                "the release target name {value:?} may hold only letters, digits, '-', '_', \
                 and '.'"
            ));
        }
        Ok(Self(value))
    }
}

/// One line of operator-written text: `what`, `published_by`, and `why`.
///
/// Each is a sentence a reader acts on and each renders on one line beside the
/// entry it describes, so a blank one leaves a reader with an identifier where they
/// were promised a sentence, and one carrying a control character renders as
/// something other than what it is wherever it lands.
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
        if value.len() > MAX_PROSE {
            return Err(format!(
                "a release declaration's prose is longer than {MAX_PROSE} characters; it is \
                 rendered on one line beside the entry it describes, and the reasoning behind it \
                 belongs in a comment"
            ));
        }
        if value.chars().any(char::is_control) {
            return Err(format!(
                "the release declaration prose {value:?} carries a control character; it is \
                 rendered on one line, so it must be one"
            ));
        }
        Ok(Self(value))
    }
}

/// A path to something the repository being released carries.
///
/// Decided on how the path is *spelled*, never on what the reader's own platform
/// makes of it: six repositories share one document and a consumer resolves it on
/// whichever machine it runs on, so a path either names a place in a checkout
/// everywhere or is refused everywhere.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct RepositoryPath(String);

impl RepositoryPath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Both separators, because one of the platforms reading a declaration separates
/// with `\` and a document meaning different things on the two would be worse than
/// one refused on either.
const SEPARATORS: [char; 2] = ['/', '\\'];

impl TryFrom<String> for RepositoryPath {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() {
            return Err("a release declaration names an empty path".to_owned());
        }
        if value.starts_with(SEPARATORS) {
            return Err(format!(
                "the release declaration path {value:?} is absolute; it is a path relative to \
                 the repository root, because it names something the repository being released \
                 carries"
            ));
        }
        // `C:\Cargo.toml`, and the drive-relative `C:Cargo.toml` with it, both name
        // a location on whichever machine resolves them rather than one in a
        // checkout. A UNC share opens with a separator and is refused above.
        let mut characters = value.chars();
        if matches!(
            (characters.next(), characters.next()),
            (Some(drive), Some(':')) if drive.is_ascii_alphabetic()
        ) {
            return Err(format!(
                "the release declaration path {value:?} names a drive on the reader's own \
                 machine; it is a path relative to the repository root"
            ));
        }
        if value.split(SEPARATORS).any(|component| component == "..") {
            return Err(format!(
                "the release declaration path {value:?} leaves the repository root; it names \
                 something the repository being released carries"
            ));
        }
        Ok(Self(value))
    }
}

/// The keys schema version 1 declares, by the table they belong to.
///
/// Spelled here rather than derived from serde's `deny_unknown_fields`, because
/// that would refuse a *later* schema's keys too — and the whole of the leniency
/// this document promises is that it does not.
const TOP_LEVEL_KEYS: [&str; 4] = ["schema_version", "probe", "target", "retired"];
const TARGET_KEYS: [&str; 6] = ["id", "name", "what", "published_by", "manifest", "covers"];
const RETIRED_KEYS: [&str; 2] = ["id", "why"];

/// Validate one release declaration's text, and answer what it declares.
///
/// `origin` is what the refusals name the document by.
pub fn validate(document: &str, origin: &str) -> Result<Declaration, String> {
    let table: toml::Table = toml::from_str(document)
        .map_err(|failure| format!("the release declaration at {origin} is not TOML: {failure}"))?;
    // The version is read before the shape is enforced, and refused before it too:
    // which keys a document may carry is a fact about the schema it declares, so
    // one this check cannot read is answered as that rather than as whichever of
    // its keys was unrecognized first.
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
            "the release declaration at {origin} declares schema_version {declared}; this check \
             reads schema_version {SCHEMA_VERSION} and newer"
        ));
    }
    if declared == SCHEMA_VERSION {
        // Only at the version this check *knows*. A typo is the likeliest defect in
        // a hand-written document and reading `manifset` as an absent `manifest`
        // would publish an answer nobody declared. A later schema's keys are not
        // this check's to have an opinion on, and are ignored.
        refuse_unknown_keys(&table, origin)?;
    }
    // Deserialized from the text rather than from the table just parsed: `toml`
    // carries the line and column of every field through a string it still has, and
    // loses them through a value it does not.
    let declaration: Declaration = toml::from_str(document).map_err(|failure| {
        format!(
            "the release declaration at {origin} is not the shape schema_version \
             {SCHEMA_VERSION} declares: {failure}"
        )
    })?;
    coherent(&declaration, origin)?;
    Ok(declaration)
}

/// Refuse a key this schema does not declare, naming it and the table it is in.
fn refuse_unknown_keys(table: &toml::Table, origin: &str) -> Result<(), String> {
    let unknown = |where_: &str, key: &str| {
        format!(
            "the release declaration at {origin} names {key:?} in {where_}, which schema_version \
             {SCHEMA_VERSION} does not declare; a misspelled key would otherwise be read as an \
             absent one"
        )
    };
    for key in table.keys() {
        if !TOP_LEVEL_KEYS.contains(&key.as_str()) {
            return Err(unknown("the document", key));
        }
    }
    for (array, keys) in [("target", &TARGET_KEYS[..]), ("retired", &RETIRED_KEYS[..])] {
        let Some(entries) = table.get(array).and_then(toml::Value::as_array) else {
            continue;
        };
        for (index, entry) in entries.iter().enumerate() {
            let Some(entry) = entry.as_table() else {
                continue;
            };
            for key in entry.keys() {
                if !keys.contains(&key.as_str()) {
                    return Err(unknown(&format!("[[{array}]] {}", index + 1), key));
                }
            }
        }
    }
    Ok(())
}

/// Refuse a declaration whose fields are each readable but which together say
/// something no repository can mean.
///
/// What is wrong on its own — an identifier that names no registry, a short name
/// outside the alphabet — is refused by its own conversion, with the line and
/// column the TOML reader knows. What only a *whole document* can be wrong about is
/// here, and each refusal names the entry by its position and its identifier.
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

/// The declaration this repository carries, refused loudly if it is one no
/// consumer could act on.
pub fn declared() -> Declaration {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(FILE);
    let document = std::fs::read_to_string(&path)
        .unwrap_or_else(|failure| panic!("read {}: {failure}", path.display()));
    validate(&document, FILE).unwrap_or_else(|refusal| panic!("{refusal}"))
}
