import { describe, expect, it } from "vitest";

import { isAdminEmail } from "@dustinedwards/site-runtime/access";

// The admin allowlist gate.

function env(adminEmail?: string, coOwners?: string): Env {
  return { ADMIN_EMAIL: adminEmail, CO_OWNER_EMAILS: coOwners } as Env;
}

describe("isAdminEmail", () => {
  it("reads the main admin and the comma-separated co-owners, trimming and lowercasing", () => {
    const e = env(" Dustin@Example.com ", " ops@Example.com ,");
    expect(isAdminEmail(e, "DUSTIN@example.com")).toBe(true);
    expect(isAdminEmail(e, "ops@example.com")).toBe(true);
    // Unset ADMIN_EMAIL closes the site to co-owners too.
    expect(isAdminEmail(env(undefined, "ops@example.com"), "ops@example.com")).toBe(false);
    expect(isAdminEmail(env(), "anyone@example.com")).toBe(false);
  });

  it("denies non-listed emails and null/undefined", () => {
    const e = env("admin@example.com");
    expect(isAdminEmail(e, "merchant@example.com")).toBe(false);
    expect(isAdminEmail(e, null)).toBe(false);
    expect(isAdminEmail(e, undefined)).toBe(false);
  });
});
