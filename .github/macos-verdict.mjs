#!/usr/bin/env node
// GitHub results are the external boundary. A carrier reports exactly which
// work ran and requires a successful classifier before admitting an omission.
const { CHANGES, MACOS, CRATE, MACOS_REQUIRED, QUALITY } = process.env;
if (CHANGES !== "success" || (QUALITY !== undefined && QUALITY !== "success")) {
  console.error("Mac carrier: prerequisite failed, cancelled or missing");
  process.exit(1);
}
if (
  !["true", "false"].includes(MACOS_REQUIRED) ||
  !["true", "false"].includes(CRATE)
) {
  console.error(
    "Mac carrier: classifier or affected selection returned no routing output",
  );
  process.exit(1);
}
if (MACOS === "success") {
  console.log("Mac cross and install proofs passed");
} else if (
  MACOS === "skipped" &&
  ["true", "false"].includes(MACOS_REQUIRED) &&
  (MACOS_REQUIRED === "false" || CRATE === "false")
) {
  console.log(
    "Mac proofs omitted by classifier or unaffected crate; no Mac tests ran",
  );
} else {
  console.error(`Mac proofs required or failed: ${MACOS ?? "missing"}`);
  process.exit(1);
}
