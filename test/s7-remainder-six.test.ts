import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { stepResultTone } from "~/lib/recovery/labels";
import {
  BACK_LINK_DEMO,
  BACK_LINK_REAL,
  COPIED_RESET_MS,
} from "~/routes/app/recovery/payments/detail";

// RULING 295, the S7 remainder's cheap visible six, specified in
// parity/S7-REMAINDER-SCOPE.md and read from legacy
// app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx at BLOB 7f54aa45.
//
// Six elements legacy renders and Foxhound did not: the back link (231-233), the
// Copy email control (257-262), the two Stripe deep links (329-360), the timeline
// step glyph (452-463), the per-step opened and clicked indicators (540-557), and
// the recovery success banner (599-612).
//
// NOT this session and asserted here only as REGRESSION GUARDS: the aggregate
// Opened and Clicked rows in the Email engagement card, and the invoice and
// customer id DetailRows. Both already existed, and legacy renders the rows AND
// the links, so a session adding the links must not remove the rows.

// CRLF-normalized: the working tree stores this file with carriage returns
// (blob d92d93cd is 29,072 bytes against 29,685 on disk, exactly one per line),
// so a multi-line matcher written for bare newlines would miss. That is the
// vacuous-plant trap from capsid/conventions, and it fired on the first run here.
const SOURCE = readFileSync("app/routes/app/recovery/payments/detail.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

// SOURCE with comments stripped. Needed because this file's own prose NAMES the
// legacy identifiers it deliberately does not use, so a bare substring search for
// them matches the explanation rather than the code. Line comments are stripped
// only when they begin the line, so a "https://" inside a string survives.
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("295 item 1: the back link", () => {
  it("carries legacy's two targets, mapped to the routes that exist", () => {
    expect(BACK_LINK_REAL).toEqual({ href: "/recovery/dashboard", label: "Back to dashboard" });
    expect(BACK_LINK_DEMO).toEqual({ href: "/recovery/payments", label: "Back to payments" });
  });

  it("the two targets DIFFER, which is the whole point of legacy's split", () => {
    // Legacy sends a demo visitor back to the payments list and a real merchant
    // back to the dashboard. Collapsing them would silently drop half the item.
    expect(BACK_LINK_REAL.href).not.toBe(BACK_LINK_DEMO.href);
    expect(BACK_LINK_REAL.label).not.toBe(BACK_LINK_DEMO.label);
  });

  it("the route switches on isDemo rather than hardcoding one of them", () => {
    expect(SOURCE).toContain("isDemo ? BACK_LINK_DEMO : BACK_LINK_REAL");
  });
});

describe("295 item 2: Copy email", () => {
  it("holds the confirmation for legacy's own 2000ms", () => {
    expect(COPIED_RESET_MS).toBe(2000);
  });

  it("writes the customer email to the clipboard and reverts on that timer", () => {
    expect(SOURCE).toContain("navigator.clipboard?.writeText(failedPayment.customerEmail)");
    expect(SOURCE).toContain("setTimeout(() => setCopied(false), COPIED_RESET_MS)");
  });

  it("confirms with a tick and Copied on Capsomer's link button (J76, Q10)", () => {
    // Recova's confirmation is green text; under Q10 the control is Capsomer's
    // link button, which keeps its own colour, so the tick and the word carry it.
    expect(SOURCE).toContain('className="cap-link-btn" onClick={copyEmail}');
    expect(SOURCE.replace(/\s+/g, " ")).toContain("{copied ? ( <> <Check");
    expect(SOURCE).toContain("Copied");
  });
});

describe("295 item 3: the two Stripe deep links", () => {
  it("both legacy URLs, keyed on the ids the loader already returns", () => {
    expect(SOURCE).toContain("https://dashboard.stripe.com/invoices/${failedPayment.stripeInvoiceId}");
    expect(SOURCE).toContain("https://dashboard.stripe.com/customers/${failedPayment.stripeCustomerId}");
  });

  it("carries rel=noopener noreferrer on the new-tab links", () => {
    // Security-relevant, not cosmetic: target=_blank without noopener hands the
    // opened tab a window.opener handle back into the app.
    const anchors = SOURCE.split("dashboard.stripe.com").length - 1;
    expect(anchors).toBe(2);
    expect(SOURCE.match(/rel="noopener noreferrer"/g)?.length).toBe(2);
    expect(SOURCE.match(/target="_blank"/g)?.length).toBe(2);
  });

  it("demo swaps both for disabled buttons under legacy's exact title", () => {
    expect(SOURCE).toContain('const DEMO_DISABLED_REASON = "Connect Stripe to use this";');
    const demoStripe = SOURCE.slice(SOURCE.indexOf("{isDemo ? (\n          <>"), SOURCE.indexOf("View customer in Stripe"));
    expect(demoStripe.match(/title=\{DEMO_DISABLED_REASON\}/g)?.length).toBe(2);
    expect(SOURCE).toContain("View invoice in Stripe");
    expect(SOURCE).toContain("View customer in Stripe");
  });

  it("REGRESSION GUARD: the id DetailRows survive, because legacy renders BOTH", () => {
    expect(SOURCE).toContain('<DetailRow label="Invoice ID"');
    expect(SOURCE).toContain('<DetailRow label="Customer ID"');
  });
});

describe("295 item 4: the timeline step glyph", () => {
  it("renders a glyph node per step, fed by the step's own state", () => {
    expect(SOURCE).toContain("<StepGlyph");
    expect(SOURCE).toContain("const executed = step.executedAt !== null;");
    expect(SOURCE).toContain("const email = isEmailStep(step.stepType);");
    expect(SOURCE).toContain("<StepGlyph executed={executed} isEmail={email}");
  });

  it("takes its tone from the SAME source the result chip takes it from", () => {
    // Legacy derives node and chip from one value so they always agree
    // (getStepResultColor). This is that invariant, expressed in Foxhound's
    // vocabulary.
    // Scoped to the StepGlyph ELEMENT. A bare substring search would be
    // satisfied by the Badge below, which already carried this prop before this
    // session, so the assertion would pass without the glyph existing at all.
    // That tautology was caught by the plant, not by review.
    const glyph = SOURCE.slice(SOURCE.indexOf("<StepGlyph"), SOURCE.indexOf("<StepGlyph") + 240);
    expect(glyph).toContain("tone={stepResultTone(step.result)}");
    expect(SOURCE).toContain("<Pill tone={PILL_TONE[stepResultTone(step.result)]}>");
  });

  it("does NOT port legacy's dead result keys, which would grey every email step", () => {
    // THE DECISIVE ONE. Legacy's map keys on email_sent_ai and
    // email_sent_fallback; Foxhound writes email_sent and has never written
    // either. Porting the literal map would colour the node neutral beside a
    // green chip on every real email step.
    expect(CODE).not.toContain("email_sent_ai");
    expect(CODE).not.toContain("email_sent_fallback");
    expect(stepResultTone("email_sent")).toBe("success");
    expect(stepResultTone("email_sent_ai")).toBe("neutral");
  });

  it("distinguishes executed from pending, as legacy's node does", () => {
    expect(SOURCE).toContain("border-border bg-border text-text-tertiary");
    expect(SOURCE).toContain("border-green bg-green-bg text-green");
    expect(SOURCE).toContain("border-red bg-red-bg text-error-text");
  });

  it("uses the envelope for email steps and the repeat glyph for retries", () => {
    expect(SOURCE).toContain("const Glyph = isEmail ? Mail : RotateCcw;");
  });
});

describe("295 item 5: the per-step opened and clicked indicators", () => {
  it("ports legacy's gate exactly: executed email step, not a failed send", () => {
    expect(SOURCE).toContain('const showEngagement = executed && email && step.result !== "email_failed";');
  });

  it("renders all four of legacy's states", () => {
    expect(SOURCE).toContain('"Not opened"');
    expect(SOURCE).toContain('"Not clicked"');
    // Recova's timeAgo ("3d ago", "5h ago"), J76.
    expect(SOURCE).toContain("`Opened ${formatTimeAgo(step.openedAt, nowMs)}`");
    expect(SOURCE).toContain("`Clicked ${formatTimeAgo(step.clickedAt, nowMs)}`");
  });

  it("greens an engaged step and leaves an unengaged one subtle", () => {
    expect(SOURCE).toContain('step.openedAt ? "text-green" : "text-text-subtle"');
    // The CLICK arm gained a second condition under ruling 377(4): a click the
    // scanner tests flagged is recorded and shown, and is not dressed as
    // engagement, so it stays subtle rather than going green. Legacy's
    // green-when-engaged treatment is unchanged for a click we do trust, which
    // is what this pin is for. Matched whitespace-independently, because the
    // condition is now long enough that the formatter owns its line breaks.
    const collapsed = SOURCE.replace(/\s+/g, " ");
    expect(collapsed).toContain(
      'step.clickedAt && !step.clickSuspectReason ? "text-green" : "text-text-subtle"',
    );
  });

  it("REGRESSION GUARD: the AGGREGATE engagement rows are untouched", () => {
    // These pre-date this session and are explicitly NOT item 5. If a future
    // edit collapses the per-step indicators into them, this fails.
    const collapsed = SOURCE.replace(/\s+/g, " ");
    expect(collapsed).toContain('label="Opened" value={`${openedEmails.length} of ${emailSteps.length}`}');
    expect(collapsed).toContain('label="Clicked" value={`${clickedEmails.length} of ${emailSteps.length}`}');
  });
});

describe("295 item 6: the recovery success banner", () => {
  it("gates on BOTH halves, a recovered status AND a recovery row", () => {
    // Legacy's own gate. A status flip with no recovered_payments row renders
    // nothing, so the banner can never claim money that has no receipt.
    expect(SOURCE).toContain('failedPayment.status === "recovered" && recovery ?');
  });

  it("carries legacy's copy and renders the amount TWICE", () => {
    expect(SOURCE).toContain("Payment recovered");
    expect(SOURCE).toContain("recovered via");
    const amounts = SOURCE.split("formatMoney(recovery.amountCents, recovery.currency)").length - 1;
    expect(amounts).toBe(2);
  });

  it("is the LAST section on the page, which is legacy's slot", () => {
    // Job 4 item 1 is an open ruling on this page's section order. Last is the
    // placement that survives it either way, because legacy's banner is last in
    // legacy's order too.
    const banner = SOURCE.indexOf('failedPayment.status === "recovered" && recovery ?');
    const actions = SOURCE.indexOf("{actionsVisible && !isDemo ? (");
    expect(actions).toBeGreaterThan(-1);
    const notes = SOURCE.indexOf("Internal notes");
    expect(banner).toBeGreaterThan(actions);
    expect(banner).toBeGreaterThan(notes);
  });
});
