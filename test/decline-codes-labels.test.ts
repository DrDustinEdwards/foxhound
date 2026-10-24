import { describe, expect, it } from "vitest";

import { CATEGORY_ORDER } from "~/lib/decline-codes/codes";
import { isRetryable } from "~/lib/recovery/decline";
import { CATEGORY_STATUS_LABEL } from "~/lib/decline-codes/presentation";

// Guards the HIGH-1 content-audit fix: the decline-codes hub (index.tsx)
// and the individual code page (code.tsx) both render this one map, so
// they cannot re-diverge into two different status claims for the same
// category the way the hub's old hardcoded ternary did.
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
