import { test } from "node:test";
import { assertPartition } from "./partition-base.mjs";

test("the split tiers run exactly the tests the original targets ran", () => {
  assertPartition();
});
