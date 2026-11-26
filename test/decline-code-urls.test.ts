import { describe, expect, it } from "vitest";

import {
  DECLINE_CODES,
  DECLINE_CODES_PATH,
  declineCodePath,
  getDeclineCodeView,
} from "~/lib/decline-codes/codes";
import { codePagePaths } from "~/routes/files/sitemap";

describe("decline-code page addresses", () => {
  it("join words with hyphens", () => {
    expect(declineCodePath("insufficient_funds")).toBe(`${DECLINE_CODES_PATH}/insufficient-funds`);
    for (const { code } of DECLINE_CODES) {
      expect(declineCodePath(code)).not.toContain("_");
    }
  });

  it("resolve from the hyphenated address only", () => {
    expect(getDeclineCodeView("insufficient-funds")?.code).toBe("insufficient_funds");
    expect(getDeclineCodeView("insufficient_funds")).toBeNull();
  });

  it("list the hyphenated addresses in the sitemap", () => {
    const paths = codePagePaths().filter((p) => p.startsWith(`${DECLINE_CODES_PATH}/`));
    expect(paths.length).toBe(DECLINE_CODES.length);
    expect(paths.every((p) => !p.includes("_"))).toBe(true);
  });
});
