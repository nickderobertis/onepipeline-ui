//! The operations a pushed change is written in, as `docs/contract.md` states
//! them for `detail.patch`, `timeline.patch` and `channel.patch`.
//!
//! Three operations and nothing else: set an object member or replace an existing
//! array element (`{p, v}`), append to an array (`{p, a}`), and delete an object
//! member (`{p, d: true}`). A path is the object keys and array indices from the
//! envelope's root. The root itself is never replaced or deleted — a patch that
//! did would be a whole snapshot in disguise — and a deletion never shifts array
//! indices, so an array that lost or reordered elements is replaced at the
//! nearest path that holds it.
//!
//! [`diff`] is how the server writes a patch: the structural difference between
//! the payload a subscriber holds and the one it should hold, element by element
//! where an array kept its elements in place and appended, and whole at the
//! array where it did not. [`apply`] is how a patch is read, and refuses every
//! operation the contract does not allow rather than guessing at it.

use serde_json::{json, Map, Value};

/// One step of a path: an object member, or an array element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// An object member, by key.
    Key(String),
    /// An array element, by index.
    Index(usize),
}

impl Step {
    fn to_json(&self) -> Value {
        match self {
            Self::Key(key) => json!(key),
            Self::Index(index) => json!(index),
        }
    }
}

/// One patch operation.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Set the object member at `path`, or replace the existing array element
    /// there.
    Set {
        /// Where.
        path: Vec<Step>,
        /// The value it now holds.
        value: Value,
    },
    /// Append `values` to the array at `path`.
    Append {
        /// The array.
        path: Vec<Step>,
        /// What it gains, in order.
        values: Vec<Value>,
    },
    /// Delete the object member at `path`.
    Delete {
        /// The member.
        path: Vec<Step>,
    },
}

impl Op {
    /// The operation as the wire writes it: `{p, v}`, `{p, a}` or `{p, d: true}`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let path = |path: &[Step]| Value::Array(path.iter().map(Step::to_json).collect());
        match self {
            Self::Set { path: p, value } => json!({ "p": path(p), "v": value }),
            Self::Append { path: p, values } => json!({ "p": path(p), "a": values }),
            Self::Delete { path: p } => json!({ "p": path(p), "d": true }),
        }
    }

    /// Read one operation off the wire, refusing anything that is not exactly
    /// one of the three.
    ///
    /// # Errors
    ///
    /// A value that is not `{p, v}`, `{p, a: [...]}` or `{p, d: true}` with a
    /// path of keys and non-negative integer indices.
    pub fn from_json(value: &Value) -> Result<Self, PatchError> {
        let object = value
            .as_object()
            .ok_or_else(|| PatchError::new("an operation is an object"))?;
        let path = object
            .get("p")
            .and_then(Value::as_array)
            .ok_or_else(|| PatchError::new("an operation names its path as an array"))?
            .iter()
            .map(|step| match step {
                Value::String(key) => Ok(Step::Key(key.clone())),
                Value::Number(index) => index
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok())
                    .map(Step::Index)
                    .ok_or_else(|| PatchError::new("an index is a non-negative integer")),
                _ => Err(PatchError::new("a path step is a key or an index")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let kinds = ["v", "a", "d"]
            .iter()
            .filter(|kind| object.contains_key(**kind))
            .count();
        if kinds != 1 || object.len() != 2 {
            return Err(PatchError::new(
                "an operation carries its path and exactly one of v, a or d",
            ));
        }
        if let Some(value) = object.get("v") {
            return Ok(Self::Set {
                path,
                value: value.clone(),
            });
        }
        if let Some(values) = object.get("a") {
            let values = values
                .as_array()
                .ok_or_else(|| PatchError::new("an append carries an array"))?;
            return Ok(Self::Append {
                path,
                values: values.clone(),
            });
        }
        if object.get("d") == Some(&Value::Bool(true)) {
            return Ok(Self::Delete { path });
        }
        Err(PatchError::new("a deletion is written d: true"))
    }
}

/// Why a patch could not be applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchError(String);

impl PatchError {
    fn new(why: &str) -> Self {
        Self(why.to_owned())
    }
}

impl std::fmt::Display for PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PatchError {}

/// The operations that turn `old` into `new`, appended to `ops`.
///
/// Objects are compared member by member and arrays element by element. An array
/// whose shared prefix kept its length gains an append for what follows; one
/// that shrank is replaced whole at its own path, because a deletion must never
/// shift indices. Two elements that are objects naming different `id`s are not
/// the same element moved, so the element is replaced rather than diffed into the
/// other's shape. Every payload this is asked about has an object at its root,
/// which is never replaced: the members inside it are.
pub fn diff(old: &Value, new: &Value, ops: &mut Vec<Op>) {
    let mut path = Vec::new();
    diff_at(&mut path, old, new, ops);
}

/// [`diff`], at `path`.
pub fn diff_at(path: &mut Vec<Step>, old: &Value, new: &Value, ops: &mut Vec<Op>) {
    if old == new {
        return;
    }
    match (old, new) {
        (Value::Object(old), Value::Object(new)) => diff_objects(path, old, new, ops),
        (Value::Array(old), Value::Array(new)) if new.len() >= old.len() => {
            for (index, (was, now)) in old.iter().zip(new).enumerate() {
                path.push(Step::Index(index));
                if same_element(was, now) {
                    diff_at(path, was, now, ops);
                } else {
                    ops.push(Op::Set {
                        path: path.clone(),
                        value: now.clone(),
                    });
                }
                path.pop();
            }
            if new.len() > old.len() {
                ops.push(Op::Append {
                    path: path.clone(),
                    values: new[old.len()..].to_vec(),
                });
            }
        }
        _ => ops.push(Op::Set {
            path: path.clone(),
            value: new.clone(),
        }),
    }
}

fn diff_objects(
    path: &mut Vec<Step>,
    old: &Map<String, Value>,
    new: &Map<String, Value>,
    ops: &mut Vec<Op>,
) {
    for key in old.keys() {
        if !new.contains_key(key) {
            path.push(Step::Key(key.clone()));
            ops.push(Op::Delete { path: path.clone() });
            path.pop();
        }
    }
    for (key, now) in new {
        path.push(Step::Key(key.clone()));
        match old.get(key) {
            Some(was) => diff_at(path, was, now, ops),
            None => ops.push(Op::Set {
                path: path.clone(),
                value: now.clone(),
            }),
        }
        path.pop();
    }
}

/// Whether two array elements are one element changed, rather than two
/// different ones in the same place: objects naming the same `id`, or anything
/// without one.
fn same_element(old: &Value, new: &Value) -> bool {
    match (old.get("id"), new.get("id")) {
        (Some(was), Some(now)) => was == now,
        (None, None) => old.is_object() == new.is_object() && old.is_array() == new.is_array(),
        _ => false,
    }
}

/// Apply `ops` to `target`, in order and all together: a patch that fails part
/// way leaves `target` as it was.
///
/// # Errors
///
/// An operation the contract does not allow — replacing or deleting the root,
/// a parent that does not exist, an index past the end of its array, an append
/// to something that is not an array, a deletion inside an array — names what
/// it refused.
pub fn apply(target: &mut Value, ops: &[Op]) -> Result<(), PatchError> {
    let mut patched = target.clone();
    for op in ops {
        apply_one(&mut patched, op)?;
    }
    *target = patched;
    Ok(())
}

/// Apply `ops` that [`diff`] wrote against `target` itself, in place.
///
/// For the writer's own bookkeeping: a payload this process diffed is the one
/// value those operations are known to apply to, so it is not copied first to
/// keep a failure atomic — which, for a timeline of tens of megabytes, is the
/// difference between a patch costing what changed and costing the timeline.
/// An operation that does not apply is reported rather than half-applied past.
///
/// # Errors
///
/// As [`apply`]; `target` then holds every operation before the refused one.
pub fn apply_trusted(target: &mut Value, ops: &[Op]) -> Result<(), PatchError> {
    ops.iter().try_for_each(|op| apply_one(target, op))
}

fn apply_one(target: &mut Value, op: &Op) -> Result<(), PatchError> {
    match op {
        Op::Set { path, value } => {
            let (last, parent) = split(path)?;
            let parent = walk(target, parent)?;
            match (parent, last) {
                (Value::Object(object), Step::Key(key)) => {
                    object.insert(key.clone(), value.clone());
                }
                (Value::Array(array), Step::Index(index)) => {
                    let element = array
                        .get_mut(*index)
                        .ok_or_else(|| PatchError::new("a set replaces an existing element"))?;
                    *element = value.clone();
                }
                _ => return Err(PatchError::new("a set's path does not match its parent")),
            }
        }
        Op::Append { path, values } => match walk(target, path)? {
            Value::Array(array) => array.extend(values.iter().cloned()),
            _ => return Err(PatchError::new("an append's path names an array")),
        },
        Op::Delete { path } => {
            let (last, parent) = split(path)?;
            match (walk(target, parent)?, last) {
                (Value::Object(object), Step::Key(key)) => {
                    object
                        .shift_remove(key)
                        .ok_or_else(|| PatchError::new("a deletion names an existing member"))?;
                }
                _ => return Err(PatchError::new("a deletion names an object member")),
            }
        }
    }
    Ok(())
}

/// The last step of a non-root path, and the steps to its parent.
fn split(path: &[Step]) -> Result<(&Step, &[Step]), PatchError> {
    path.split_last()
        .ok_or_else(|| PatchError::new("the root is never replaced or deleted"))
}

fn walk<'a>(mut value: &'a mut Value, path: &[Step]) -> Result<&'a mut Value, PatchError> {
    for step in path {
        value = match (value, step) {
            (Value::Object(object), Step::Key(key)) => object
                .get_mut(key)
                .ok_or_else(|| PatchError::new("a parent on the path does not exist"))?,
            (Value::Array(array), Step::Index(index)) => array
                .get_mut(*index)
                .ok_or_else(|| PatchError::new("an index on the path does not exist"))?,
            _ => return Err(PatchError::new("a path step does not match its parent")),
        };
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patched(old: &Value, new: &Value) -> (Value, Vec<Op>) {
        let mut ops = Vec::new();
        diff(old, new, &mut ops);
        let mut applied = old.clone();
        apply(&mut applied, &ops).expect("a diff applies");
        (applied, ops)
    }

    #[test]
    fn a_diff_applied_is_the_new_value_and_appends_rather_than_restates() {
        let old = json!({"spans": [{"id": "a", "events": [1, 2]}], "gone": 1, "same": [1]});
        let new = json!({"spans": [{"id": "a", "events": [1, 2, 3]}, {"id": "b"}], "same": [1], "added": true});
        let (applied, ops) = patched(&old, &new);
        assert_eq!(applied, new);
        let wire: Vec<Value> = ops.iter().map(Op::to_json).collect();
        assert_eq!(
            wire,
            [
                json!({"p": ["gone"], "d": true}),
                json!({"p": ["spans", 0, "events"], "a": [3]}),
                json!({"p": ["spans"], "a": [{"id": "b"}]}),
                json!({"p": ["added"], "v": true}),
            ]
        );
    }

    #[test]
    fn an_array_that_shrank_or_reordered_is_replaced_at_its_own_path() {
        let old = json!({"list": [{"id": "a"}, {"id": "b"}], "order": [{"id": "a"}, {"id": "b"}]});
        let new = json!({"list": [{"id": "a"}], "order": [{"id": "b"}, {"id": "a"}]});
        let (applied, ops) = patched(&old, &new);
        assert_eq!(applied, new);
        assert!(ops.iter().all(|op| !matches!(op, Op::Delete { .. })));
        assert_eq!(ops[0].to_json(), json!({"p": ["list"], "v": [{"id": "a"}]}));
    }

    #[test]
    fn the_wire_form_round_trips_and_refuses_what_the_contract_does_not_allow() {
        for op in [
            json!({"p": ["a", 0], "v": 1}),
            json!({"p": [], "a": [1]}),
            json!({"p": ["a"], "d": true}),
        ] {
            assert_eq!(Op::from_json(&op).expect("valid").to_json(), op);
        }
        for refused in [
            json!({"p": ["a"], "v": 1, "a": [1]}),
            json!({"p": ["a"], "d": false}),
            json!({"p": [-1], "v": 1}),
            json!({"p": "a", "v": 1}),
            json!({"p": ["a"], "a": 1}),
            json!({"p": ["a"], "v": 1, "x": 2}),
        ] {
            assert!(Op::from_json(&refused).is_err(), "{refused}");
        }
        let mut root = json!({"a": [1], "o": {}});
        for refused in [
            Op::Set { path: vec![], value: json!({}) },
            Op::Delete { path: vec![] },
            Op::Set { path: vec![Step::Key("missing".into()), Step::Key("x".into())], value: json!(1) },
            Op::Set { path: vec![Step::Key("a".into()), Step::Index(5)], value: json!(1) },
            Op::Delete { path: vec![Step::Key("a".into()), Step::Index(0)] },
            Op::Append { path: vec![Step::Key("o".into())], values: vec![json!(1)] },
            Op::Delete { path: vec![Step::Key("o".into()), Step::Key("none".into())] },
        ] {
            let before = root.clone();
            assert!(apply(&mut root, &[Op::Append { path: vec![Step::Key("a".into())], values: vec![json!(2)] }, refused]).is_err());
            assert_eq!(root, before, "a failed patch changes nothing");
        }
        let mut array_root = json!([1]);
        apply(&mut array_root, &[Op::Append { path: vec![], values: vec![json!(2)] }]).expect("the root array appends");
        assert_eq!(array_root, json!([1, 2]));
    }
}
