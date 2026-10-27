// The SBOM every npm platform package carries, and what counts as one.
//
// A host that installs onepipeline-api from npm reads this file to prove which
// release of the engine the binary links before it adopts the binary beside
// that engine, so its place and its shape are a shared interface rather than a
// detail of this repository's packaging: scripts/npm-build.mjs writes it,
// scripts/release-package.py holds the packed tarball to it, and
// scripts/release.mjs refuses to publish a platform package without it.

// The one file under `sboms/` a platform package ships, relative to its root.
export const PACKAGED_SBOM = "sboms/onepipeline-api.cyclonedx.json";

// The crate the document must describe: the one whose binary the package carries.
const CRATE = "onepipeline-ui";

// Why `text` is not this binary's CycloneDX JSON document, or undefined when it
// is. It reads the shape a consumer relies on, not the whole schema: an object
// whose `bomFormat` is CycloneDX, describing this crate under a `bom-ref`, with
// the `components` and `dependencies` arrays a consumer walks.
export function cycloneDxProblem(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return `is not JSON (${error.message})`;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return "is not a JSON object";
  if (doc.bomFormat !== "CycloneDX")
    return `has bomFormat ${JSON.stringify(doc.bomFormat)}, not "CycloneDX"`;
  const component = doc.metadata?.component;
  if (component?.name !== CRATE || typeof component["bom-ref"] !== "string")
    return `does not describe ${CRATE} under a bom-ref in metadata.component`;
  if (!Array.isArray(doc.components) || !Array.isArray(doc.dependencies))
    return "has no components[] and dependencies[] arrays";
  return undefined;
}
