/**
 * What the app publishes to the journeys that drive it.
 *
 * `dag-ui-e2e` is a project of its own, so it reaches the app the way anything
 * else does — by the package's name — and this is the whole of that surface. A
 * journey importing `../src/...` would be a project reaching into another one's
 * files, which `@nx/enforce-module-boundaries` refuses and which would make every
 * internal move of this app a change to the journeys.
 *
 * The category vocabulary and nothing else, because that is the one thing a
 * journey cannot restate: `EVENT_CATEGORIES` is what "one record of every
 * category is drawn" is counted against, and a journey holding its own copy would
 * pass while the app grew a category nobody drew.
 */
export {
  EVENT_CATEGORIES,
  type EventCategory,
  eventCategoryLabel,
} from "../features/timeline/event-category";
