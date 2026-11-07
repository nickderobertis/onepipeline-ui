import type {
  HumanItemDetail,
  HumanItemView,
  SubscriptionView,
} from "@onepipeline-ui/dag-model";

/**
 * Action items on the tab's one subscription, as the app composes them: the view
 * the page asks for, and what the subscription currently holds of it. Here rather
 * than under either feature because the page's selection names the view and the
 * subscription serves it.
 */

/** A subscription to Action items. */
export type HumanItemsView = Extract<SubscriptionView, { type: "human-items" }>;

/** What the subscription currently holds of Action items. */
export interface LiveHumanItems {
  /** The items the view's filter selects, in the engine's order. */
  readonly items?: readonly HumanItemView[];
  /** The selected item's detail: `null` once it no longer reads. */
  readonly detail?: HumanItemDetail | null;
  /** The item `detail` is about: what the view named when it was served. */
  readonly item?: string;
  /** Why the view could not be served: the sidebar is carried on regardless. */
  readonly error?: string;
}
