import { describe, expect, it } from "vitest";

import { isDisposableEmail } from "~/lib/auth/disposable-emails";
import { adminEmails, isAdminEmail } from "~/lib/auth/roles";

// Pure auth logic (no DB): the admin allowlist parsing and the disposable-email
// blocklist. The DB-backed account/invite flow is verified against a live D1
// (staging round-trip / local wrangler dev), not here.

function env(adminEmail?: string): Env {
  return { ADMIN_EMAIL: adminEmail } as Env;
}

describe("adminEmails / isAdminEmail", () => {
  it("returns no admins when ADMIN_EMAIL is unset", () => {
    expect(adminEmails(env())).toEqual([]);
    expect(isAdminEmail(env(), "anyone@example.com")).toBe(false);
  });

  it("parses a comma-separated allowlist, trimming and lowercasing", () => {
    const e = env(" Dustin@Example.com , ops@Example.com ");
    expect(adminEmails(e)).toEqual(["dustin@example.com", "ops@example.com"]);
    expect(isAdminEmail(e, "DUSTIN@example.com")).toBe(true);
    expect(isAdminEmail(e, "ops@example.com")).toBe(true);
  });

  it("denies non-listed emails and null/undefined", () => {
    const e = env("admin@example.com");
    expect(isAdminEmail(e, "merchant@example.com")).toBe(false);
    expect(isAdminEmail(e, null)).toBe(false);
    expect(isAdminEmail(e, undefined)).toBe(false);
  });
});

describe("isDisposableEmail", () => {
  it("flags known disposable domains (case-insensitive)", () => {
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@Guerrillamail.com")).toBe(true);
    expect(isDisposableEmail("x@YOPMAIL.com")).toBe(true);
  });

  it("handles malformed input without throwing", () => {
    expect(isDisposableEmail("not-an-email")).toBe(false);
    expect(isDisposableEmail("")).toBe(false);
  });
});
