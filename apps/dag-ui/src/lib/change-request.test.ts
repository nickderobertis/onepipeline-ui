import { describe, expect, test } from "vitest";
import { changeRequestId } from "./change-request";

describe("changeRequestId", () => {
  test("names a GitHub pull request by its repository and number", () => {
    expect(
      changeRequestId("https://github.com/nickderobertis/crozier/pull/769"),
    ).toBe("crozier#769");
    expect(changeRequestId("https://github.com/example/widgets/pull/12/")).toBe(
      "widgets#12",
    );
  });

  test("keeps a readable name for a URL it cannot parse", () => {
    expect(changeRequestId("not a url")).toBe("Change request");
    expect(changeRequestId("https://example.com/reviews/769")).toBe(
      "Change request",
    );
  });

  test("names nothing for a missing URL", () => {
    expect(changeRequestId(undefined)).toBeUndefined();
    expect(changeRequestId("")).toBeUndefined();
  });
});
