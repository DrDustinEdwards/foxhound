import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";

// SESSION 66, RULING 360: M22's four scope cards.
//
// THE WALK'S FINDING, and it is why all four are RESTATE rather than WIRE.
// NOTHING IN FOXHOUND EVER WRITES `audit_runs`. Legacy computes all four scopes
// in lib/audit-engine.ts's runAudit from live Stripe reads; Foxhound has no such
// run, so there is no producer to wire and no scope that a query over existing
// tables could fill, because the tables an audit would read are populated by
// Foxhound's own engines running on an account that has already connected.
//
// These plants pin the restated copy, and the one that matters most is the
// derived one: if anything ever starts writing `audit_runs`, the "no run
// exists" assertion goes red and this decision gets revisited on purpose.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const AUDIT_PAGE = read("app/routes/audit.tsx");

/** Source with comments stripped, so an assertion cannot pass on a comment that
 *  EXPLAINS the thing it is asserting is absent (session 57's lesson). */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const AUDIT_CODE = code(AUDIT_PAGE);

/** JSX wraps prose across lines, so a sentence assertion has to compare against
 *  collapsed whitespace or it is really asserting the formatter's line breaks. */
const AUDIT_PROSE = AUDIT_CODE.replace(/\s+/g, " ");

describe("PLANT 1: the finding the restatement rests on", () => {
  it("NOTHING IN app/ WRITES audit_runs, so no audit run exists to report", () => {
    // DERIVED, not transcribed. The day a producer lands, this goes red and the
    // four cards get their walk again rather than staying restated by inertia.
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) {
          const body = readFileSync(full, "utf8");
          if (/insert\(\s*auditRuns\s*\)/.test(body)) writers.push(full);
        }
      }
    };
    walk(fileURLToPath(new URL("app", ROOT)));
    expect(writers).toEqual([]);
  });

  it("and the lift-band layer is still wired to no route", () => {
    // full-audit.server.ts's two computations. computeFoxhoundAddsCents has one
    // caller, the monthly digest; computeStripeInvoiceLiftBands has none.
    // COMMENTS STRIPPED FIRST. digest.server.ts's own header EXPLAINS that
    // computeStripeInvoiceLiftBands is deliberately not called here, so a raw
    // grep fails on the explanation. Session 57's lesson, and this plant walked
    // straight into it on the first run.
    const digest = code(read("app/lib/audit/digest.server.ts"));
    expect(digest).toContain("computeFoxhoundAddsCents");
    expect(digest).not.toContain("computeStripeInvoiceLiftBands");
  });
});

describe("PLANT 2: the restated cards", () => {
  it("the section no longer claims a full audit covers four scopes", () => {
    expect(AUDIT_CODE).not.toContain("What the full audit covers");
    expect(AUDIT_CODE).toContain("What Foxhound shows you once Stripe is connected");
  });

  it("each of the four lines describes a surface that exists", () => {
    // The topics survive the restatement; the CLAIM about them is what moved.
    for (const title of ["Failed payments", "Expiring cards", "Open disputes", "MRR and movement"]) {
      expect(AUDIT_PROSE, `${title} missing`).toContain(title);
    }
    // And each named surface really is there, asserted against routes.ts rather
    // than against the copy's own confidence.
    const routes = read("app/routes.ts");
    expect(routes).toContain('route("expiring-cards"');
    expect(routes).toContain('...prefix("disputes"');
    expect(routes).toContain('...prefix("intelligence"');
  });

  it("BUSINESS HEALTH IS GONE, because Foxhound computes no ARR and no churn bps", () => {
    // The one scope whose topic did not survive: legacy's card promises MRR,
    // ARR, active subscriptions and voluntary versus involuntary churn in basis
    // points. Foxhound has MRR and its movement and none of the other three.
    expect(AUDIT_CODE).not.toContain("Business health");
    expect(AUDIT_CODE).not.toContain("ARR");
    expect(AUDIT_CODE).not.toContain("involuntary churn");
  });

  it("the CTA promises what connecting does, not a report that does not exist", () => {
    expect(AUDIT_PROSE).not.toContain("the full report");
    expect(AUDIT_PROSE).toContain("Want your real numbers instead of an estimate?");
    expect(AUDIT_PROSE).toContain("Turn on the monthly summary under Settings and Audit");
  });

  it("and the meta description stops promising a full diagnostic", () => {
    expect(AUDIT_PROSE).toContain("Connect Stripe afterward to see your real numbers.");
    expect(AUDIT_PROSE).not.toContain("for the full diagnostic");
  });
});

describe("PLANT 3: the audit stays free, and nothing here created a path off that", () => {
  it("the audit route records no outcome, no billing row and no attribution", () => {
    // PRICING rev 3: the audit is free. A restatement is copy, and this is the
    // pin that it stayed copy.
    for (const forbidden of [
      "recordOutcome",
      "executeMoneyWrite",
      "billingLineItems",
      "recoveredPayments",
      "findAttributionSignals",
    ]) {
      expect(AUDIT_CODE, `${forbidden} reached the audit route`).not.toContain(forbidden);
    }
  });

  it("the estimator's own gates are untouched", () => {
    // 311's fail-open rate limit and the Turnstile hard requirement are not this
    // session's to change, so they are pinned rather than assumed.
    expect(AUDIT_CODE).toContain("if (!env.TURNSTILE_SECRET_KEY)");
    expect(AUDIT_CODE).toContain("verifyTurnstileToken");
    expect(AUDIT_CODE).toContain("recordEstimatorRun");
  });
});

describe("PLANT 4: the docs guide agrees with the page", () => {
  const auditGuide = DOC_GUIDES.find((g) => g.slug === "audit")!;
  const text = auditGuide.sections
    .map((s) => {
      const flat = (b: DocBlock): string => {
        if (typeof b === "string") return b;
        const inline = (n: DocInline): string =>
          typeof n === "string"
            ? n
            : "code" in n
              ? n.code
              : "strong" in n
                ? n.strong
                : "mono" in n
                  ? n.mono
                  : n.link;
        const rich = (r: string | DocInline[]): string =>
          typeof r === "string" ? r : r.map(inline).join("");
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
          case "widget":
            return b.name;
        }
      };
      return `${s.heading}\n${s.body.map(flat).join("\n")}`;
    })
    .join("\n");

  it("the part-two sentence is replaced, not left describing the old cards", () => {
    // Session 65 wrote "Failed invoices is the scope that produces numbers
    // today. The other three are named because the audit page names them."
    // The page no longer names them, so that sentence is now false about the
    // page and has to go with it.
    expect(text).not.toContain("The other three are named because the audit page names them");
  });

  it("and says what the page says: no audit run, and here is what does exist", () => {
    expect(text).toContain("Foxhound runs no full audit of its own yet.");
  });
});
