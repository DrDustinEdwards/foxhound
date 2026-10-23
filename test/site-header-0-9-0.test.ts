
import { describe, expect, it } from "vitest";

import { merchantAccountMenu } from "~/components/site-header";

// Capsomer 0.9.0's site header on Foxhound (job_da34077992a5; capsomer
// docs/design/design-site-header.md, Dustin's answers of 2026-10-13, recorded as
// approved differences in parity/APPROVED-DIFFERENCES.md). These pin the
// header's contract on the RENDERED markup where a render is possible (the
// public header) and on the layouts' source where the shell needs a route
// tree: the order of the slots, the avatar menu that replaced the gear, teal on
// the band in place of amber, and the owner and user variants.





describe("the avatar menu's rows", () => {
  const base = {
    name: "Sam Rivera",
    email: "sam@example.com",
    businessName: "Acme Supply Co.",
    isAdmin: false,
    pathname: "/dashboard",
    onSignOut: () => {},
  };

  it("drops Billing without an account (legacy's gate) and adds Admin for an admin", () => {
    const menu = merchantAccountMenu({ ...base, hasAccount: false, isAdmin: true });
    expect(menu.groups?.[0]?.links.map((l) => l.label)).not.toContain("Billing");
    expect(menu.groups?.[1]?.links.map((l) => l.label)).toEqual(["Help", "Admin"]);
  });
});
