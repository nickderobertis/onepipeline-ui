import { describe, expect, it } from "vitest";
import { firstAddress } from "../first-screen/address";
import { DETAIL_LEVELS, type DetailLevel } from "../lib/useUrlSelection";

/**
 * The drift gate for the first-screen chunk's reading of the address.
 *
 * `first-screen/address.ts` copies the two detail words' filter profiles rather than
 * importing `useUrlSelection`, whose module the first-screen chunk must not load. The
 * app takes the first answer over only when the view it would subscribe equals the one
 * the first screen subscribed, so a copied profile that drifted would draw a first
 * screen under one filter and then read the run again under the other.
 */
describe("the first screen subscribes the filter the app would", () => {
  const filterFor = (search: string) =>
    firstAddress(search, "/")?.view as { readonly filter?: string } | undefined;

  for (const level of Object.keys(DETAIL_LEVELS) as DetailLevel[])
    it(`under ?detail=${level}`, () => {
      expect(filterFor(`?run=r&view=graph&detail=${level}`)?.filter).toBe(
        DETAIL_LEVELS[level].profile,
      );
    });

  it("with no detail word, the app's default level's", () => {
    // `useUrlSelection` reads an absent or unknown word as `activity`.
    for (const search of ["?run=r&view=overall", "?run=r&detail=other"])
      expect(filterFor(search)?.filter).toBe(DETAIL_LEVELS.activity.profile);
  });
});
