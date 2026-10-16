import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import { PAYMENTS_DEFAULT_PAGE_SIZE, PAYMENTS_PAGE_SIZE_OPTIONS } from "~/lib/recovery/payments-list";

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

describe("PLANT 1: the guide's shape", () => {
  it("carries legacy's four Parts, so a dropped section cannot ship silently", () => {
    expect(recovery.sections.map((s) => s.heading)).toEqual([
      "Managing payments",
      "Recovery sequences",
      "Understanding your dashboard",
      "Troubleshooting",
    ]);
  });

  it("carries H3 subheadings, pinned by count", () => {
    const h3s = recovery.sections
      .flatMap((s) => s.body)
      .filter((b): b is { kind: "h3"; text: string } => typeof b !== "string" && b.kind === "h3");
    // J73: Recova's twenty, in its order. Recova's "Contact support" is cut,
    // because Foxhound's support inbox is unverified (RULES 3.22, 7.6).
    expect(h3s).toHaveLength(20);
  });
});

describe("PLANT 2: every capability sentence, tied to its code", () => {
  it("SIX DECLINE CATEGORIES, which is the claim session 33's audit found FALSE", () => {
    // The heading map recorded this as claim 3: the shipped sentence said four
    // categories while RECOVERY_SCHEDULES had six, so Foxhound's docs were
    // contradicted by Foxhound's own engine. The set is derived from the record
    // rather than transcribed, and the table names all six.
    expect(TEXT).toContain(
      "Declines are sorted into six categories: soft, network, expired, fraud, revoked, and unknown.",
    );
    expect(Object.keys(RECOVERY_SCHEDULES).sort()).toEqual([
      "expired",
      "fraud",
      "network",
      "revoked",
      "soft",
      "unknown",
    ]);
  });

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

  it("ROWS PER PAGE: the options, and legacy's default of 25", () => {
    expect(TEXT).toContain(
      "The selector above the table shows 10, 25, 50, 100, or all of them. It starts at 25.",
    );
    // J75: the page's own numbers, read from the module it renders them from.
    expect(PAYMENTS_PAGE_SIZE_OPTIONS).toEqual([10, 25, 50, 100, "all"]);
    expect(PAYMENTS_DEFAULT_PAGE_SIZE).toBe(25);
    const source = readFileSync(
      fileURLToPath(new URL("../app/routes/app/recovery/payments/index.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain(": PAYMENTS_DEFAULT_PAGE_SIZE;");
  });

  it("MANUAL ACTIONS: the five that exist, and no sixth", () => {
    // J73: the labels the payment page renders, not shorthand for them.
    for (const label of [
      "Trigger next step now.",
      "Mark as recovered.",
      "Stop recovery.",
      "Resend last email.",
      "Note.",
    ]) {
      expect(TEXT, `${label} missing`).toContain(label);
    }
    const actions = readFileSync(
      fileURLToPath(new URL("../app/lib/recovery/manual-actions.server.ts", import.meta.url)),
      "utf8",
    );
    expect(actions).toContain(
      'MANUAL_ACTION_INTENTS = ["trigger", "mark_recovered", "cancel", "resend"]',
    );
  });

  it("AND SAYS PLAINLY THAT THE REWRITE CONTROL DOES NOT EXIST", () => {
    // Ruling 304: Foxhound DECLINES legacy's edit-the-queued-email control. A
    // guide that simply omitted it would leave a merchant hunting for it.
    expect(TEXT).toContain("Foxhound has no rewrite-the-pending-email control.");
  });

  it("WEBHOOK HEALTH: one day, three days, and a connection that has seen none", () => {
    expect(TEXT).toContain(
      "A webhook inside the last day reads as receiving normally, nothing for a day reads as quiet, and nothing for more than three days is flagged as a problem worth checking.",
    );
    const window = readFileSync(
      fileURLToPath(new URL("../app/lib/dashboard/recovery-window.ts", import.meta.url)),
      "utf8",
    );
    expect(window).toContain('label: "Waiting for the first webhook"');
    expect(window).toContain('label: "No webhook in over 3 days"');
  });

  it("NINE STAT CARDS, not legacy's six", () => {
    expect(TEXT).toContain("Nine stat cards sit on the recovery dashboard: three across the top and six further down");
    const dashboard = readFileSync(
      fileURLToPath(new URL("../app/routes/app/recovery/index.tsx", import.meta.url)),
      "utf8",
    );
    expect(dashboard).toContain('label="Win-backs active"');
    // Recova's own label (StatCards.tsx, blob b1923468), restored by J74.
    expect(dashboard).toContain('label="Best category"');
    expect(dashboard).toContain('label="Avg days to recovery"');
  });

  it("EMAILS SENT is a 30-day card, as the stat-card sentence says", () => {
    expect(TEXT).toContain("They read the last 30 days whatever range is selected.");
    expect(TEXT).toContain("Recovery emails sent in the last 30 days, with their open and click rates.");
    const dashboard = readFileSync(
      fileURLToPath(new URL("../app/routes/app/recovery/index.tsx", import.meta.url)),
      "utf8",
    );
    expect(dashboard).toContain("value={String(w.emailsSentInRange.sent)}");
  });

  it("ROI THIS MONTH is every attributed recovery since the 1st, billed only after maturity", () => {
    expect(TEXT).toContain(
      "This month counts every such recovery since the 1st, with the fee it will carry once it has held for 30 days; all time counts the ones that have held for 30 days, which are the ones Foxhound bills.",
    );
  });

  it("DELIVERABILITY shows bounces and spam reports, and no delivered rate", () => {
    expect(TEXT).toContain(
      "The email deliverability panel, under the stat cards, follows the range: the share of the emails Foxhound sent that bounced or were reported as spam.",
    );
    expect(TEXT).toContain("It shows no delivered rate, because Foxhound does not record delivery.");
    expect(TEXT).toContain(
      "Foxhound does not yet record bounces and spam reports against the account that sent the email, so for now the panel says there is nothing to show.",
    );
    expect(TEXT).not.toContain("Until Email Service reports a bounce or a complaint");
  });

  it("BILLABLE: the sentence that shipped, carried through unchanged", () => {
    expect(TEXT).toContain(
      "A recovery is billable only when a Foxhound action provably preceded payment",
    );
  });

  it("SUPPRESSION is described as holding, because it does", () => {
    expect(TEXT).toContain(
      "A customer who unsubscribed, hard bounced, or reported an email as spam is suppressed, and Foxhound will not send to them again.",
    );
    const suppression = readFileSync(
      fileURLToPath(new URL("../app/lib/email/suppression.ts", import.meta.url)),
      "utf8",
    );
    expect(suppression).toContain("emailSuppressions");
  });
});

describe("PLANT 3: what the guide must NOT say", () => {
  it("carries no ROI widget, no 56% benchmark, and no invented open or click rates", () => {
    // Three legacy headings, all NOT PORTABLE for one reason: they are platform
    // figures Foxhound has no history to support. 181 froze the ROI widget's
    // pricing claims and core.md records the benchmark card as deliberately
    // omitted.
    // J73: Recova's "ROI widget" heading is back, because Foxhound now draws
    // the panel it describes (Foxhound-attributed revenue on the recovery
    // dashboard). Recova's pricing figures inside it stay out.
    expect(TEXT).not.toContain("56%");
    expect(TEXT).toContain("Foxhound-attributed revenue panel");
    expect(TEXT).not.toContain("Typical range");
    expect(TEXT).not.toContain("30-55");
  });

  it("names no support address, because Foxhound's still bounces", () => {
    // Launch blocker 7: apex Email Routing is not set up, so support@ is not
    // deliverable, and legacy's own address is not Foxhound's to hand out.
    expect(TEXT).not.toContain("support@");
  });

  it("carries no wide dash anywhere in the guide", () => {
    expect(TEXT).not.toContain(String.fromCharCode(0x2014));
    expect(TEXT).not.toContain(String.fromCharCode(0x2013));
  });
});
