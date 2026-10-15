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
  it("EXACTLY ONE MODULE WRITES audit_runs, and it is the audit's own", () => {
    // MOVED IN SESSION 69, WHICH IS WHAT THIS PLANT WAS FOR. Session 66 asserted
    // that NOTHING wrote `audit_runs`, and said in as many words that the day a
    // producer landed it would go red and the cards would get their walk again.
    // Phase (d) is that producer, so the assertion moves from "none" to "one,
    // and it is the expected one", which still fails in both directions.
    //
    // THE CARDS STAY RESTATED, and the reason is unchanged: a run now exists but
    // nothing TRIGGERS one yet. Phases (e) through (g) build the surfaces and the
    // cron, and the cards get their walk again when they do.
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
    expect(writers.map((p) => p.slice(p.indexOf("app/")).split("\\").join("/"))).toEqual([
      "app/lib/audit/persist.server.ts",
    ]);
  });

  it("and the lift-band layer is still wired to no route", () => {
    // full-audit.server.ts's two computations. computeFoxhoundAddsCents has one
    // caller, the merged monthly audit; computeStripeInvoiceLiftBands has none.
    //
    // MOVED IN PHASE (g). digest.server.ts is gone, because 362 ruling 3 merged
    // its send into the monthly audit, and monthly.server.ts is the module that
    // absorbed it. The property is unchanged and still holds in both directions.
    //
    // COMMENTS STRIPPED FIRST, and the reason survived the move: the reading
    // module's own header EXPLAINS that computeStripeInvoiceLiftBands is
    // deliberately not called, so a raw grep fails on the explanation. Session
    // 57's lesson, which this plant walked straight into on its first run.
    const monthly = code(read("app/lib/audit/monthly.server.ts"));
    expect(monthly).toContain("computeFoxhoundAddsCents");
    expect(monthly).not.toContain("computeStripeInvoiceLiftBands");
  });
});

describe("PLANT 2: the cards, UN-RESTATED in session 71 phase (f)", () => {
  // THIS IS WHAT THE RESTATEMENT WAS ALWAYS FOR. Session 66 rewrote these four
  // lines because no audit could run, and every assertion below was written in
  // its negative form on the understanding that it would invert on the day a
  // visitor could complete the flow. Phase (f) is that day: /audit/connect mints
  // a read-only grant, /audit/callback exchanges it, and /audit/results runs the
  // engine over the merchant's live Stripe account.
  it("the section claims what the audit covers again, in legacy's words", () => {
    expect(AUDIT_CODE).toContain("What the audit covers");
    expect(AUDIT_CODE).not.toContain("What Foxhound shows you once Stripe is connected");
  });

  it("each of the four lines names a scope the ENGINE computes", () => {
    for (const title of [
      "Failed invoices",
      "Expiring cards",
      "Open disputes",
      "Business health",
    ]) {
      expect(AUDIT_PROSE, `${title} missing`).toContain(title);
    }
    // DERIVED, not trusted. Each card's scope is asserted against the engine's
    // own result type rather than against the copy's confidence. A card naming a
    // scope `runAudit` does not return is the over-promise 360 opened M22 for,
    // and this is the direction that check has to run now that the cards claim
    // an audit again.
    const engine = read("app/lib/audit/engine.ts");
    for (const scope of ["failedInvoices", "expiringCards", "disputes", "health"]) {
      expect(engine, `${scope} is not a scope of AuditResult`).toContain(
        `  ${scope}: ScopeOutcome<`,
      );
    }
  });

  it("BUSINESS HEALTH IS BACK, because the engine computes ARR and both churn rates", () => {
    // Session 66 asserted this topic GONE, on the measurement that Foxhound had
    // MRR and none of the other three. HealthScope now carries all four, so the
    // assertion inverts against the very type that made it false.
    expect(AUDIT_CODE).toContain("Business health");
    expect(AUDIT_CODE).toContain("ARR");
    expect(AUDIT_CODE).toContain("involuntary churn");
    const engine = read("app/lib/audit/engine.ts");
    for (const field of [
      "arrCents",
      "activeSubscriptionsCount",
      "voluntaryChurnRateBps",
      "involuntaryChurnRateBps",
    ]) {
      expect(engine, `HealthScope is missing ${field}`).toContain(`  ${field}: number;`);
    }
  });

  it("TWO CLAUSES OF LEGACY'S OWN COPY STAY OUT, because those renders do not exist", () => {
    // 365 binding 31 ruled both NOT PORTABLE, and un-restating the cards must
    // not quietly re-promise what the surfaces still refuse to draw: legacy's
    // "estimated recoverable amount" is AUDIT_RECOVERY_ESTIMATE_PCT, and its
    // dispute "historical win rate" is a platform figure with no Foxhound
    // history behind it.
    expect(AUDIT_PROSE).not.toContain("estimated recoverable amount");
    expect(AUDIT_PROSE).not.toContain("win rate");
    // COMMENTS STRIPPED FIRST. The sections module's own header NAMES both
    // absent renders in order to explain why they are absent, so a raw grep
    // fails on the explanation. Session 57's trap, walked into once here on the
    // first run of this assertion and fixed the standing way.
    const sections = code(read("app/components/audit/sections.tsx"));
    expect(sections).not.toContain("AUDIT_RECOVERY_ESTIMATE_PCT");
    expect(sections).not.toContain("Platform median");
  });

  it("every CTA on the page points at the flow that now exists", () => {
    // THREE CONTROLS, and session 66 repointed all three at /signup because the
    // audit could not run. Counted rather than merely checked present: a stray
    // /signup left on one of the three is the N-1-of-N miss the
    // enumerate-every-site rule exists for.
    expect(AUDIT_PROSE).not.toContain("the full report");
    expect(AUDIT_PROSE).toContain("See my numbers");
    expect(AUDIT_PROSE).toContain("Read-only Stripe access. 30 seconds. No account required.");
    expect(AUDIT_PROSE).toContain("Run the free audit");
    expect(AUDIT_PROSE).toContain("Run the free audit on your real numbers");
    const connectLinks = AUDIT_CODE.match(/to="\/audit\/connect"/g) ?? [];
    expect(connectLinks).toHaveLength(3);
    expect(AUDIT_CODE).not.toContain('to="/signup"');
    // And the destination is a real route, asserted against routes.ts.
    expect(read("app/routes.ts")).toContain('route("audit/connect"');
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
                  : "badge" in n
                    ? String(n.badge)
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

  it("and says what is true at this sha: the audit RUNS", () => {
    // MOVED IN SESSION 71, and this is the version with no hedge left in it,
    // because phase (f) removed the thing every previous hedge was about.
    expect(text).toContain(
      "Foxhound runs the full audit on demand: connect Stripe from the audit page and the run happens while you wait.",
    );
    expect(text).toContain(
      "Where a scope could not be read, it says so rather than showing you a zero",
    );
    // EVERY EARLIER STATE OF THE SENTENCE, asserted absent rather than only the
    // most recent one. A guide that accumulates its own history is how two
    // contradictory claims end up on one page.
    expect(text).not.toContain("nothing writes an audit record");
    expect(text).not.toContain("nothing starts one yet");
    expect(text).not.toContain("Until there is a way to start a run");
  });
});
