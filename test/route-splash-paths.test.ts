import { describe, expect, it } from "vitest";

import { isSplashPath } from "~/lib/navigation/route-splash";

describe("the paths that splash", () => {
  it("covers the four app pages and a payment's detail", () => {
    for (const path of [
      "/recovery/dashboard",
      "/recovery/payments",
      "/recovery/payments/dfp_46",
      "/recovery/sequence",
      "/settings",
    ]) {
      expect(isSplashPath(path), path).toBe(true);
    }
  });

  it("leaves the CSV export, net-new pages and everything else alone", () => {
    for (const path of [
      "/recovery/payments/export.csv",
      "/recovery/winback",
      "/recovery/expiring-cards",
      "/settings/team",
      "/billing",
    ]) {
      expect(isSplashPath(path), path).toBe(false);
    }
  });
});
