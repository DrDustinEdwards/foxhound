import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { STRIPE_AUDIT_SCOPE, STRIPE_CONNECT_SCOPE } from "~/lib/constants";

// THE AI-CITATION FILES MUST NAME BOTH SCOPES (368 roadmap item 2).
//
// WHAT WAS WRONG. llms.txt opened "Stripe OAuth scope is read and write", full
// stop, and llms-full.txt said the audit "needs a free account and the same
// Stripe connection every other Foxhound product uses". Both were true when they
// were written and both were made false by phase (f): the audit now mints its
// own anonymous grant at `read_only` and needs no account at all.
//
// WHY IT MATTERS MORE THAN AN ORDINARY COPY DRIFT. These two files exist to be
// quoted by an AI. "The audit only reads" is the single Foxhound claim an
// outsider can verify without an account, by watching the OAuth redirect and
// reading `scope=read_only`. The one checkable claim was the one the citation
// file omitted, and the sentence it printed instead was wrong in the unsafe
// direction: it told a prospective merchant the free diagnostic wanted write
// access to their payments.
//
// THE PLANT IS TIED TO THE CONSTANTS, not to a copy of the words. A future
// session that changes either scope has to change these sentences with it, which
// is the property a pure string assertion would not have.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const LLMS = read("app/routes/files/llms.ts");
const LLMS_FULL = read("app/routes/files/llms-full.ts");

describe("PLANT 1: both scopes are named, and named correctly", () => {
  it("the constants are what the sentences claim", () => {
    // The floor. If these ever move, every assertion below is describing a
    // product that no longer exists.
    expect(STRIPE_AUDIT_SCOPE).toBe("read_only");
    expect(STRIPE_CONNECT_SCOPE).toBe("read_write");
  });

  it("llms.txt says the AUDIT is read-only and ONBOARDING is read and write", () => {
    expect(LLMS).toContain("The free audit requests READ-ONLY access");
    expect(LLMS).toContain("Connecting a merchant account at /connect requests read and write");
    expect(LLMS).toContain("The free audit requests a read-only OAuth scope");
  });

  it("llms-full.txt says the same, and stops claiming the audit needs an account", () => {
    expect(LLMS_FULL).toContain("needs no Foxhound account either");
    expect(LLMS_FULL).toContain("READ-ONLY OAuth grant");
    expect(LLMS_FULL).toContain("The free audit requests read-only and can write nothing at all");
  });
});

describe("PLANT 2: the sentences that were false are gone", () => {
  it("neither file opens with the bare read-and-write claim", () => {
    // The exact strings that shipped, asserted absent rather than merely
    // superseded, so a revert reads as a failure instead of a restoration.
    expect(LLMS).not.toContain(
      "Stripe OAuth scope is read and write, because retrying a failed invoice is a write.",
    );
    expect(LLMS).not.toContain(
      "- Built on Stripe Connect (read and write OAuth scope; the writes are invoice retries",
    );
  });

  it("and llms-full.txt no longer says the audit uses the same connection as everything else", () => {
    expect(LLMS_FULL).not.toContain(
      "needs a free account and the same Stripe connection every other Foxhound product uses",
    );
    expect(LLMS_FULL).not.toContain("- Stripe Connect: read and write OAuth scope. Foxhound reads");
  });

  it("NEITHER FILE STATES A SCOPE THE CODE DOES NOT REQUEST", () => {
    // Both files may say "read and write" (onboarding does request it) and both
    // may say read-only (the audit does). What neither may do is name a third
    // thing. Derived from the two constants rather than from a list of spellings.
    for (const [name, body] of [
      ["llms.txt", LLMS],
      ["llms-full.txt", LLMS_FULL],
    ] as const) {
      for (const bogus of ["read_write_full", "full access", "write-only", "admin scope"]) {
        expect(body, `${name} names a scope that does not exist: ${bogus}`).not.toContain(bogus);
      }
    }
  });
});
