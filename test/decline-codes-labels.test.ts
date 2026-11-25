import { describe, expect, it } from "vitest";

import { CATEGORY_ORDER } from "~/lib/decline-codes/codes";
import { isRetryable } from "~/lib/recovery/decline";
import { CATEGORY_STATUS_LABEL } from "~/lib/decline-codes/presentation";

describe("CATEGORY_STATUS_LABEL", () => {
  it("only claims automatic retry for categories decline.ts actually marks retryable", () => {
    for (const category of CATEGORY_ORDER) {
      if (CATEGORY_STATUS_LABEL[category] === "Retries automatically") {
        expect(isRetryable(category)).toBe(true);
      } else {
        expect(isRetryable(category)).toBe(false);
      }
    }
  });
});
