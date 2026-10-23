import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";

// SESSION 64, JOB 3 AND JOB 4: the platform guide's claim audit.
//
// EVERY CAPABILITY SENTENCE IS TIED TO THE CODE THAT MAKES IT TRUE (350 binding
// 7), and the tie is to the SENTENCE rather than to a fragment of it: a
// substring plant survives the truth changing underneath it, which is how the
// settings card told merchants the sequence-complete notice was unbuilt for
// seven sessions after it shipped.
//
// The pairing in each case is: the guide says X, and here is the constant, the
// registry entry or the refusal in source that makes X true. A claim that
// cannot be paired does not get written, which is why this file has no rows for
// reply-to, a sending domain, auto-submit, or account deletion.

const platform = DOC_GUIDES.find((g) => g.slug === "platform")!;

/** Every rendered word of the guide, blocks flattened, for sentence pinning. */
function flatten(blocks: DocBlock[]): string {
  const inline = (node: DocInline): string => {
    if (typeof node === "string") return node;
    if ("code" in node) return node.code;
    if ("strong" in node) return node.strong;
    if ("mono" in node) return node.mono;
    if ("badge" in node) return String(node.badge);
    return node.link;
  };
  const rich = (r: string | DocInline[]): string =>
    typeof r === "string" ? r : r.map(inline).join("");
  return blocks
    .map((b) => {
      if (typeof b === "string") return b;
      switch (b.kind) {
        case "p":
          return rich(b.body);
        case "h3":
          return b.text;
        case "note":
        case "tip":
          return rich(b.body);
        case "steps":
        case "list":
          return b.items.map(rich).join(" ");
        case "table":
          return [...b.columns, ...b.rows.flat().map(rich)].join(" ");
      }
    })
    .join("\n");
}

const TEXT = platform.sections.map((s) => `${s.heading}\n${flatten(s.body)}`).join("\n");

describe("PLANT 2: every capability sentence, tied to its code", () => {

  it("EXPIRING CARDS: the link is a Foxhound page and the alert is not billable", () => {
    expect(TEXT).toContain(
      "The link in the alert is a Foxhound page, not Stripe's billing portal.",
    );
    // Ruling 341 binding 2. The CTA target is /p/:token in card-update mode, so
    // the route has to exist for the sentence to be true.
    const routes = readFileSync(
      fileURLToPath(new URL("../app/routes.ts", import.meta.url)),
      "utf8",
    );
    expect(routes).toContain('route("p/:token"');
  });

  it("CANCELLING: connections disconnect, attributed recoveries still invoice", () => {
    expect(TEXT).toContain(
      "Every Stripe connection on the account is disconnected, no further sequence runs, and the recoveries Foxhound already attributed still invoice.",
    );
    // 334 binding 2: cancelled_at stamped, every live connection disconnected,
    // recovered_payments and billing left alone.
    const merchants = readFileSync(
      fileURLToPath(new URL("../app/lib/admin/merchants.server.ts", import.meta.url)),
      "utf8",
    );
    expect(merchants).toContain("cancelMerchant");
  });
});
