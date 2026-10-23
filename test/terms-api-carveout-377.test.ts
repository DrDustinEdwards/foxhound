import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DENIED_TOOL_FRAGMENTS, isDeniedToolName } from "~/lib/mcp/registry";
import { MERCHANT_TOOL_NAMES } from "~/lib/mcp/tools.server";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");

// 377(10): THE TERMS FORBADE THE PRODUCT.
//
// Section 3 had every user represent that "you will not access the Services
// through automated or non-human means", while Foxhound publishes an MCP
// endpoint whose entire purpose is automated access. Verified at 2569400. A
// merchant using the endpoint as designed was in breach of the terms they
// accepted, which is GitHub's scraping-versus-API split done backwards.
//
// The carve-out names the endpoint and points at a short API terms block.
//
// WHY A BLOCK INSIDE SECTION 3 AND NOT A NEW NUMBERED SECTION: the page carries
// 26 numbered sections with a table of contents and an anchor per section.
// Inserting a section 4 renumbers 23 sections and breaks every deep link into
// them, which is a structural change to a legal page and well past the "no
// layout, no treatment" line this session works under. 377(10) says "a short API
// terms block follows", and a block is what this is.
//
// THE PLANT TIES THE TERMS TO THE DENYLIST CONSTANT, which is the whole point of
// the item: the four things the Terms promise are never exposed are the four the
// registry refuses by construction, so the document and the code cannot disagree
// without something going red.

const terms = read("app/routes/terms.tsx");

describe("PLANT 2: the never-exposed four are the denylist's own four", () => {
  /**
   * The Terms sentence, mapped to the registry fragments that make it true.
   *
   * DERIVED AGAINST THE CONSTANT, not restated: each phrase a merchant reads is
   * paired with the denylist fragments that enforce it, so deleting a fragment
   * from the registry makes the Terms a false promise and turns this red.
   */
  const PROMISES: { inTerms: string; enforcedBy: string[] }[] = [
    { inTerms: "submitting dispute evidence", enforcedBy: ["submit_dispute", "dispute_submit"] },
    { inTerms: "connecting a Stripe account", enforcedBy: ["connect_stripe", "stripe_connect"] },
    { inTerms: "disconnecting a Stripe account", enforcedBy: ["disconnect"] },
    { inTerms: "records an outcome or bills", enforcedBy: ["record_outcome", "charge", "refund"] },
  ];

  it("every promise in the Terms is enforced by a denylist fragment", () => {
    // The reader, mutated: an empty promise list or an empty denylist would make
    // the loop below assert nothing (379 binding 3).
    expect(PROMISES).toHaveLength(4);
    expect(DENIED_TOOL_FRAGMENTS.length).toBeGreaterThan(0);

    for (const promise of PROMISES) {
      expect(terms, `the Terms do not promise: ${promise.inTerms}`).toContain(promise.inTerms);
      for (const fragment of promise.enforcedBy) {
        expect(
          DENIED_TOOL_FRAGMENTS,
          `the Terms promise "${promise.inTerms}" but ${fragment} is not denied`,
        ).toContain(fragment);
      }
    }
  });

  it("and no registered tool could perform one of them", () => {
    // The behavioural half. A fragment present in the list proves the rule
    // exists; this proves nothing has slipped past it.
    expect(MERCHANT_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const name of MERCHANT_TOOL_NAMES) {
      expect(isDeniedToolName(name), `${name} is a denied action`).toBe(false);
    }
    // And the denial genuinely discriminates: a tool with one of these names
    // would be refused.
    for (const promise of PROMISES) {
      for (const fragment of promise.enforcedBy) {
        expect(isDeniedToolName(`merchant_${fragment}_tool`)).toBe(true);
      }
    }
  });
});
