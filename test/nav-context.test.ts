import { describe, expect, it } from "vitest";

import { resolveNavContext } from "~/lib/nav/context";

// The app shell's nav context comes from the path alone: a product page highlights its product, any other page the console.
describe("resolveNavContext", () => {
  it("a product page highlights that product", () => {
    expect(resolveNavContext("/recovery/dashboard")).toEqual({
      activeProductKey: "recovery",
      isPlatformPage: false,
    });
  });

  it("a platform page highlights the console", () => {
    expect(resolveNavContext("/settings")).toEqual({
      activeProductKey: "dashboard",
      isPlatformPage: true,
    });
  });
});
