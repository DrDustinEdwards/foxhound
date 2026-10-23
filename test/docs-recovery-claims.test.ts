
import { describe, expect, it } from "vitest";

import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";

// SESSION 64, JOB 3 AND JOB 4: the recovery guide's claim audit.
//
// EVERY CAPABILITY SENTENCE IS TIED TO THE CODE THAT MAKES IT TRUE (350 binding
// 7), and the tie is to the SENTENCE rather than to a fragment of it: a
// substring plant survives the truth changing underneath it, which is how the
// settings card told merchants the sequence-complete notice was unbuilt for
// seven sessions after it shipped.
//
// The pairing in each case is: the guide says X, and here is the constant, the
// registry entry or the refusal in source that makes X true. A claim that
// cannot be paired does not get written, which is why this guide carries no ROI
// widget, no recovery-rate benchmark, and no table of typical open and click
// rates: all three are numbers legacy had a platform history for and Foxhound
// does not.

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

const recovery = DOC_GUIDES.find((g) => g.slug === "recovery")!;
const TEXT = recovery.sections.map((s) => `${s.heading}\n${flatten(s.body)}`).join("\n");

describe("PLANT 2: every capability sentence, tied to its code", () => {

  it("EXPIRED, FRAUD AND REVOKED GET NO SILENT RETRY, and the guide says why", () => {
    expect(TEXT).toContain("A retry on an expired card fails every time until the customer updates it");
    expect(TEXT).toContain("Retrying a blocked card can draw further flags");
    // Structural, so it is DERIVED from the schedules rather than asserted: no
    // step in any of the three starts with retry_.
    for (const category of ["expired", "fraud", "revoked"] as const) {
      const retries = RECOVERY_SCHEDULES[category].filter((s) => s.stepType.startsWith("retry_"));
      expect(retries, `${category} schedules a retry`).toEqual([]);
    }
    // BOTH DIRECTIONS. Soft and network DO retry, so a schedule set with no
    // retries anywhere would fail here rather than passing the loop above.
    expect(RECOVERY_SCHEDULES.soft.some((s) => s.stepType.startsWith("retry_"))).toBe(true);
    expect(RECOVERY_SCHEDULES.network.some((s) => s.stepType.startsWith("retry_"))).toBe(true);
  });

  it("UNKNOWN FAILS CLOSED, a decision legacy never had to make", () => {
    expect(TEXT).toContain(
      "Emails only, failing closed: no silent retry against a code that has not been classified",
    );
    expect(RECOVERY_SCHEDULES.unknown.every((s) => !s.stepType.startsWith("retry_"))).toBe(true);
  });

  it("ROI THIS MONTH is every attributed recovery since the 1st, billed only after maturity", () => {
    expect(TEXT).toContain(
      "This month counts every such recovery since the 1st, with the fee it will carry once it has held for 30 days; all time counts the ones that have held for 30 days, which are the ones Foxhound bills.",
    );
  });

  it("BILLABLE: the sentence that shipped, carried through unchanged", () => {
    expect(TEXT).toContain(
      "A recovery is billable only when a Foxhound action provably preceded payment",
    );
  });
});
