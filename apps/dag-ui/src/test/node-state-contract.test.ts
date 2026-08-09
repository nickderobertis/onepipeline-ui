import { DAG_NODE_STATES } from "@onepipeline-ui/dag-layout";
import { nodeStatusSchema } from "@onepipeline-ui/dag-model";
import { expect, it } from "vitest";

/**
 * The drift gate between the node-status vocabulary and the states the graph draws.
 *
 * `dag-model`'s `nodeStatusSchema` owns the vocabulary; `dag-layout`'s
 * `DAG_NODE_STATES` restates it, because the layout package is geometry and takes no
 * dependency on the model. Nothing derives one from the other, and the typecheck only
 * catches the half of a drift that reaches a call site — a status the model gains and
 * the layout has never heard of surfaces as a missing style token at run time, on
 * whichever node happens to be in it.
 *
 * This app is the one project that depends on both, so this is where the two lists can
 * be put beside each other. Order is compared as well as membership: the layout list
 * is read in order wherever a state has to be ranked.
 */
it("draws exactly the node statuses the model defines, in the same order", () => {
  expect([...DAG_NODE_STATES]).toEqual([...nodeStatusSchema.options]);
});
