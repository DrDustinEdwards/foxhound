import { describe, expect, it } from "vitest";

import { labelForTag } from "~/lib/blog/tags";

describe("labelForTag", () => {

  it("humanizes an unrecognized tag instead of throwing or 404ing", () => {
    expect(labelForTag("some-future-tag")).toBe("some future tag");
  });
});
