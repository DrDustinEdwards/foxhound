import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { failedPayments } from "~/db/schema";
import { parseManualIntent } from "~/lib/recovery/manual-actions.server";

// RULING 296, the S7 remainder's Session 2: plan_name, the stale-artifact sweep,
// the stale test name, and the email sub-line repair. Legacy is
// app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx at BLOB 7f54aa45.
//
// CRLF-normalized and comment-stripped for the same reasons 295's file records:
// the working tree stores these files with carriage returns, so a multi-line
// matcher written for bare newlines misses; and these files' own prose NAMES the
// identifiers they deliberately no longer use, so a bare substring search for a
// removed symbol matches the explanation rather than the code.
const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE = norm("app/routes/app/recovery/payments/detail.tsx");
const ROUTE_CODE = strip(ROUTE);
const DISPATCH = norm("app/lib/recovery/manual-actions.server.ts");
const DISPATCH_CODE = strip(DISPATCH);

describe("296 item 1: plan_name", () => {
  it("needed NO loader field: the column is on the row the loader already selects", () => {
    // The scope doc estimated one loader field. It needed zero:
    // getFailedPaymentDetail does a bare db.select() over failedPayments, so the
    // whole row (planName included) was already in the payload.
    expect(failedPayments.planName).toBeDefined();
    expect(norm("app/lib/recovery/queries.server.ts")).not.toContain("planName: failedPayments.planName");
  });

  it("renders only when present, as legacy does", () => {
    expect(ROUTE_CODE).toContain("failedPayment.planName ? (");
  });

  it("carries legacy's middot separator", () => {
    expect(ROUTE_CODE).toContain("&middot; {failedPayment.planName}");
  });

  it("sits AFTER the Copy email control, which is legacy's order", () => {
    const copy = ROUTE.indexOf('"Copy email"');
    const plan = ROUTE.indexOf("failedPayment.planName");
    expect(copy).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(copy);
  });
});

describe("296 item 4: the email sub-line", () => {
  it("renders only when a customer name exists", () => {
    expect(ROUTE_CODE).toContain("failedPayment.customerName ? (");
  });

  it("REGRESSION GUARD: the title still falls back to the email", () => {
    // This is what MAKES the conditional correct. If the h1 stopped falling
    // back, hiding the sub-line would lose the address entirely on a nameless
    // payment rather than de-duplicating it.
    expect(ROUTE_CODE).toContain("{failedPayment.customerName ?? failedPayment.customerEmail}");
  });
});

describe("296 item 2: the stale-artifact sweep", () => {
  it("the three stale claims that the actions are unwired are gone", () => {
    expect(ROUTE).not.toContain("not built yet for anyone");
    expect(ROUTE).not.toContain("Intents this session has not wired");
    expect(ROUTE).not.toContain("still refuses every intent");
  });

  it("the unreachable not-available constant is gone from the route", () => {
    expect(ROUTE).not.toContain("MANUAL_ACTIONS_NOT_AVAILABLE_MESSAGE = ");
    expect(ROUTE_CODE).not.toContain("MANUAL_ACTIONS_NOT_AVAILABLE_MESSAGE");
  });

  it("the unreachable not_wired outcome is gone from the dispatcher", () => {
    expect(DISPATCH_CODE).not.toContain("not_wired");
  });

  it("both files now enforce exhaustiveness through the type system instead", () => {
    // The replacement is stronger than the string it replaced: a sixth intent,
    // or a new outcome reason, is a COMPILE error rather than a runtime message.
    // tsc passing at all is what proves these narrow to never.
    expect(DISPATCH_CODE).toContain("const exhaustive: never = intent;");
    expect(ROUTE_CODE).toContain("const exhaustive: never = outcome;");
  });

  it("unknown_intent gained its OWN case with an honest message", () => {
    expect(ROUTE_CODE).toContain('case "unknown_intent":');
    expect(ROUTE_CODE).toContain('"Unrecognized action."');
    // The old message promised a feature to someone asking for one that does
    // not exist. It must not come back under any spelling.
    expect(ROUTE).not.toContain("isn't available yet");
  });

  it("and that case is REACHABLE, so the default was never the only path", () => {
    // Behavioural, not source-text. This is why the default could not simply be
    // deleted: a hand-crafted POST carrying a bogus intent still lands here.
    expect(parseManualIntent("garbage")).toBeNull();
    expect(parseManualIntent(null)).toBeNull();
    expect(parseManualIntent(42)).toBeNull();
    // REGRESSION GUARD: the five real intents still parse, or the honest
    // refusal above would start swallowing legitimate submissions.
    for (const ok of ["trigger", "mark_recovered", "cancel", "resend", "note"]) {
      expect(parseManualIntent(ok)).toBe(ok);
    }
  });
});
