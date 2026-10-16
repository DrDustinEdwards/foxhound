import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DocWidget, DOC_WIDGET_NAMES, type DocWidgetName } from "~/components/docs/doc-widgets";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { DISPUTE_STATE_LABELS } from "~/lib/disputes/labels";
import { WATCH_CEILING, healthScoreBand } from "~/lib/intelligence/health-band";
import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS } from "~/lib/recovery/labels";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";

// SESSION 65: the audit, disputes and intelligence guides, and the preview
// widgets the session 65 walk ruled.
//
// THE WIDGETS ARE DERIVED, NOT TRANSCRIBED, and that is what these plants pin.
// A picture of four decline categories beside a six-key engine is the same
// defect Foxhound's own four-categories sentence carried until part one, so
// every widget that shows a set reads it from the constant the engine owns.

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
        case "widget":
          return b.name;
      }
    })
    .join("\n");
}

function textOf(slug: string): string {
  const guide = DOC_GUIDES.find((g) => g.slug === slug)!;
  return guide.sections.map((s) => `${s.heading}\n${flatten(s.body)}`).join("\n");
}

function renderWidget(name: DocWidgetName): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DocWidget, { name })),
  );
}

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const AUDIT = textOf("audit");
const DISPUTES = textOf("disputes");
const INTELLIGENCE = textOf("intelligence");

describe("PLANT 1: shape, so a dropped section cannot ship silently", () => {
  it("each guide carries its Parts", () => {
    const headings = (slug: string) =>
      DOC_GUIDES.find((g) => g.slug === slug)!.sections.map((s) => s.heading);
    // J73: Recova's Parts, in Recova's order (test/docs-guides-j73.test.ts
    // pins the same lists against the legacy blobs).
    expect(headings("audit")).toEqual([
      "How the Audit works",
      "The four scopes",
      "Reading your results",
      "Saving results",
      "Auto-run",
      "Using the audit to evaluate Foxhound",
    ]);
    expect(headings("disputes")).toEqual([
      "How Disputes works",
      "Dispute triage",
      "Evidence building",
      "Submitting a dispute",
      "Accepting a dispute",
      "Settings",
      "Billing",
    ]);
    expect(headings("intelligence")).toEqual([
      "How Intelligence works",
      "Health scores",
      "Recommendations",
      "Churn risk",
      "MRR trends",
      "AI analyst",
      "Settings",
    ]);
  });

  it("H3 counts are pinned per guide", () => {
    const h3s = (slug: string) =>
      DOC_GUIDES.find((g) => g.slug === slug)!
        .sections.flatMap((s) => s.body)
        .filter((b) => typeof b !== "string" && b.kind === "h3");
    // J73: Recova's H3s that are true of Foxhound. Disputes keeps File uploads
    // and Intelligence keeps Health alert as headings that say what is not
    // built, rather than dropping the place a merchant would look.
    expect(h3s("audit")).toHaveLength(4);
    expect(h3s("disputes")).toHaveLength(5);
    expect(h3s("intelligence")).toHaveLength(3);
  });

  it("every built widget is used by a guide, and every used widget is built", () => {
    // Derived in BOTH directions (350 binding 6's mechanism): an orphaned widget
    // and a guide referring to one that does not exist both fail here.
    const used = new Set(
      DOC_GUIDES.flatMap((g) => g.sections)
        .flatMap((s) => s.body)
        .filter((b): b is { kind: "widget"; name: DocWidgetName } =>
          typeof b !== "string" && b.kind === "widget",
        )
        .map((b) => b.name),
    );
    expect([...used].sort()).toEqual([...DOC_WIDGET_NAMES].sort());
  });
});

describe("PLANT 2: the widgets draw what the engine computes", () => {
  it("DECLINE CATEGORIES: all six, from DECLINE_CATEGORY_LABELS", () => {
    const html = renderWidget("decline-categories");
    for (const [key, label] of Object.entries(DECLINE_CATEGORY_LABELS)) {
      expect(html, `${key} missing from the picture`).toContain(label);
    }
    expect(Object.keys(DECLINE_CATEGORY_LABELS)).toHaveLength(6);
  });

  it("PAYMENT STATUSES: all four, and the last one reads Failed, not the column value", () => {
    const html = renderWidget("payment-statuses");
    for (const label of Object.values(FAILED_PAYMENT_STATUS_LABELS)) {
      expect(html).toContain(label);
    }
    // Legacy's own showcase says "Failed unrecovered". The tab word on both
    // sides is "Failed", and shipping a database enum to a merchant is a defect.
    expect(html).not.toContain("Failed unrecovered");
  });

  it("SEQUENCE TIMELINES: one row per category, every step in schedule order", () => {
    const html = renderWidget("sequence-timelines");
    for (const [category, steps] of Object.entries(RECOVERY_SCHEDULES)) {
      expect(html).toContain(
        DECLINE_CATEGORY_LABELS[category as keyof typeof DECLINE_CATEGORY_LABELS],
      );
      expect(html, `${category} step count`).toContain(
        steps.length === 1 ? "1 step" : `${steps.length} steps`,
      );
    }
    // SILENT-FIRST IS VISIBLE, which is the divergence the redraw exists for:
    // soft and network open with a Retry chip, and legacy's picture opens every
    // category with an Email.
    const soft = html.slice(html.indexOf("Soft decline"), html.indexOf("Network error"));
    expect(soft.indexOf("Retry")).toBeLessThan(soft.indexOf("Email"));
  });

  it("HEALTH BANDS: Foxhound's cutoffs, and the picture agrees with the scorer", () => {
    const html = renderWidget("health-bands");
    expect(html).toContain(`Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`);
    expect(html).toContain(`${WATCH_CEILING} and above`);
    // The claim under the picture is that a 38 is at risk here and would be
    // watch on legacy. Asserted against the real scorer rather than the label.
    expect(healthScoreBand(38)).toBe("at_risk");
    expect(healthScoreBand(WATCH_CEILING)).toBe("healthy");
    expect(html).not.toContain("0-33");
  });

  it("DISPUTE STATES: all six, in order, from DISPUTE_STATE_LABELS", () => {
    const html = renderWidget("dispute-states");
    const labels = Object.values(DISPUTE_STATE_LABELS);
    expect(labels).toHaveLength(6);
    let cursor = -1;
    for (const label of labels) {
      const at = html.indexOf(`>${label}<`);
      expect(at, `${label} missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // No triage anywhere: `triage_recommendation` has no producer outside the
    // demo seeder, so the walk ruled TriagePill OMIT.
    expect(html).not.toContain("Fight");
    expect(html).not.toContain("Triage");
  });

  it("AUDIT SCOPES: the same four names the /audit page renders", () => {
    // MOVED IN SESSION 66, and the guard firing is the mechanism working. The
    // page's four names changed under ruling 360 when the walk found nothing
    // writes `audit_runs`, and this assertion went red rather than letting the
    // docs picture keep the old promise.
    const html = renderWidget("audit-scopes");
    // MOVED AGAIN AT J73: /audit (app/routes/audit.tsx) renders Recova's four
    // names now, so the picture follows the page.
    for (const scope of ["Failed invoices", "Expiring cards", "Open disputes", "Business health"]) {
      expect(html).toContain(scope);
      expect(read("app/routes/audit.tsx")).toContain(`"${scope}"`);
    }
    expect(html).not.toContain("MRR and movement");
  });

  it("CUSTOMER COLUMNS: Foxhound's six, with no Recommended action column", () => {
    const html = renderWidget("customer-columns");
    for (const column of ["Customer", "Plan", "MRR", "Health", "Last seen", "Signals"]) {
      expect(html).toContain(column);
    }
    // `ai_recommended_actions` has no writer, so the column is dropped rather
    // than rendered empty.
    expect(html).not.toContain("Recommended action");
  });
});

describe("PLANT 3: every capability sentence, tied to its code", () => {
  it("DISPUTES: the 355 sentence survives VERBATIM", () => {
    // Ruled NEVER PORTABLE at 355, on two grounds: PRICING rev 3 makes the
    // approval gate schema-enforced with no override, and this exact sentence is
    // already published. It is pinned here so no later session softens it.
    expect(DISPUTES).toContain("There is no auto-submit toggle. There never has been.");
  });

  it("DISPUTES: the approval gate is described as enforced, and it is", () => {
    expect(DISPUTES).toContain(
      "The approval step is enforced by the database, not by a setting.",
    );
    // The six states, with approved between pending_review and submitted, are
    // the enforcement. A state set that let submitted follow pending_review
    // directly would make the sentence false.
    const order = Object.keys(DISPUTE_STATE_LABELS);
    expect(order.indexOf("approved")).toBeGreaterThan(order.indexOf("pending_review"));
    expect(order.indexOf("submitted")).toBeGreaterThan(order.indexOf("approved"));
  });

  it("DISPUTES: the cap sentence carries the real number, per 359 binding 3", () => {
    expect(DISPUTES).toContain("capped at $500 per dispute");
  });

  it("INTELLIGENCE: the paid layer, and no free tier the gate contradicts", () => {
    // J73: every Intelligence page is gated by isIntelligenceEntitled, so the
    // "at no charge" sentence was false of the product and is cut.
    expect(INTELLIGENCE).not.toContain("at no charge");
    expect(INTELLIGENCE).toContain("Intelligence is the paid layer, at $199 per month");
    // And the truthful qualifier: it is granted, not buyable.
    expect(INTELLIGENCE).toContain("There is no self-serve checkout for it yet");
  });

  it("AUDIT: read-only, and it says so about writing back", () => {
    expect(AUDIT).toContain("The audit only reads.");
    expect(AUDIT).toContain(
      "Your billing configuration, your subscriptions and your payment methods are never touched.",
    );
  });

  it("AUDIT: says the audit RUNS, which is what phase (f) made true", () => {
    // THE THIRD AND LAST STATE OF THIS SENTENCE, and the arc is the point.
    // Session 65: "Failed invoices is the scope that produces numbers today."
    // Session 66's walk found something stronger and the sentence became
    // "nothing writes an audit record". Phases (a) to (d) made that half false
    // and session 70 halved it again to "can compute and record, nothing starts
    // one yet". Phase (f) built the thing that starts one, so the hedge is gone
    // and the guide says what the product does.
    expect(AUDIT).toContain(
      "Foxhound runs the full audit on demand: connect Stripe from the audit page and the run happens while you wait.",
    );
    // EVERY EARLIER STATE OF THE SENTENCE IS ASSERTED ABSENT, not just the last
    // one. A guide that accumulates its own history is how two contradictory
    // claims end up on one page, which is the failure 360 opened M22 for.
    expect(AUDIT).not.toContain("The other three are named because the audit page names them");
    expect(AUDIT).not.toContain("nothing writes an audit record");
    expect(AUDIT).not.toContain("nothing starts one yet");
    expect(AUDIT).not.toContain("Until there is a way to start a run");
  });

  it("AUDIT: no fabricated recovery rate, and it says why", () => {
    expect(AUDIT).toContain("The audit does not project a recovery rate from platform-wide statistics");
    expect(AUDIT).toContain(
      // 376 item 17 took the previous product's name out of the customer docs.
      // The claim this pins is unchanged, which is why the substring moved
      // rather than the assertion being dropped: Foxhound publishes no flat
      // recovery estimate, and that sentence is still the one on the page.
      "Foxhound applies no flat recovery estimate to at-risk value",
    );
  });
});

describe("PLANT 4: what the three guides must NOT say", () => {
  it("no triage score, no seven action types, no weekly narrative, no health alert", () => {
    // Four legacy headings with no Foxhound producer: the triage score, the
    // seven recommended actions, the Monday narrative email, and the
    // score-threshold alert. None is described.
    for (const forbidden of ["triage score", "Seven action", "Weekly narrative"]) {
      expect(`${DISPUTES}\n${INTELLIGENCE}`).not.toContain(forbidden);
    }
    // J73: Recova's "Health alert" heading stays, and what sits under it is
    // Settings and Alerts' metric thresholds, with the per-customer alert
    // stated as absent.
    expect(INTELLIGENCE).toContain("it does not alert on one customer's score");
  });

  it("no legacy platform win rates and no Teamflow demo figures", () => {
    const all = `${AUDIT}\n${DISPUTES}\n${INTELLIGENCE}`;
    expect(all).not.toContain("75%");
    expect(all).not.toContain("Teamflow");
    expect(all).not.toContain("NRR");
    expect(all).not.toContain("36%");
  });

  it("no wide dash in any of the three", () => {
    const all = `${AUDIT}\n${DISPUTES}\n${INTELLIGENCE}`;
    expect(all).not.toContain(String.fromCharCode(0x2014));
    expect(all).not.toContain(String.fromCharCode(0x2013));
  });
});

describe("PLANT 5: the whole content module", () => {
  it("carries no wide dash anywhere, across all five guides", () => {
    const all = DOC_GUIDES.map((g) => `${g.title} ${g.description} ${textOf(g.slug)}`).join("\n");
    expect(all).not.toContain(String.fromCharCode(0x2014));
    expect(all).not.toContain(String.fromCharCode(0x2013));
    // Non-vacuous: the text really was read.
    expect(all.length).toBeGreaterThan(20_000);
  });
});
