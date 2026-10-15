import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DocWidget, DOC_WIDGET_NAMES } from "~/components/docs/doc-widgets";
import { HealthScoreBadge } from "~/components/docs/health-score-badge";
import { AUDIT_LOOKBACK_DAYS, HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { RECOVERY_RANGES } from "~/lib/dashboard/recovery-window";
import { DEADLINE_SOON_DAYS, DEADLINE_URGENT_DAYS } from "~/lib/disputes/labels";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";
import { classifyDecline } from "~/lib/recovery/decline";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import DocGuidePage from "~/routes/docs/page";

// J73, row M18: the five guides carry Recova's Part structure, with every claim
// true of Foxhound's engine, on Capsomer's components.
//
// THE SPEC IS RECOVA'S SOURCE, read whole at these blobs through Capsid's repo
// "legacy": app/(marketing)/docs/platform/page.tsx 2b69517b, audit 3b1153b4,
// recovery 6166a6be, disputes 598fcbaa, intelligence e7f18266. The Part lists
// below are their TOC arrays, word for word, with "Recova" read as "Foxhound"
// (branding, RULES.md 1.2). The H3 lists are their H3 children in order.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

function inlineText(node: DocInline): string {
  if (typeof node === "string") return node;
  if ("code" in node) return node.code;
  if ("strong" in node) return node.strong;
  if ("mono" in node) return node.mono;
  if ("badge" in node) return String(node.badge);
  return node.link;
}
const rich = (r: string | DocInline[]): string => (typeof r === "string" ? r : r.map(inlineText).join(""));

function blockText(b: DocBlock): string {
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
      return b.items.map(rich).join("\n");
    case "table":
      return [...b.columns, ...b.rows.flat().map(rich)].join("\n");
    case "widget":
      return "";
  }
}

const guide = (slug: string) => DOC_GUIDES.find((g) => g.slug === slug)!;
const textOf = (slug: string) =>
  guide(slug)
    .sections.map((s) => [s.heading, ...s.body.map(blockText)].join("\n"))
    .join("\n");
const h3sOf = (slug: string) =>
  guide(slug)
    .sections.flatMap((s) => s.body)
    .flatMap((b) => (typeof b !== "string" && b.kind === "h3" ? [b.text] : []));

const RECOVA_PARTS: Record<string, string[]> = {
  platform: ["Getting started", "Additional features", "Settings reference"],
  audit: [
    "How the Audit works",
    "The four scopes",
    "Reading your results",
    "Saving results",
    "Auto-run",
    "Using the audit to evaluate Foxhound",
  ],
  recovery: ["Managing payments", "Recovery sequences", "Understanding your dashboard", "Troubleshooting"],
  disputes: [
    "How Disputes works",
    "Dispute triage",
    "Evidence building",
    "Submitting a dispute",
    "Accepting a dispute",
    "Settings",
    "Billing",
  ],
  intelligence: [
    "How Intelligence works",
    "Health scores",
    "Recommendations",
    "Churn risk",
    "MRR trends",
    "AI analyst",
    "Settings",
  ],
};

// Recova's H3s, in order, MINUS the ones cut because the feature they describe
// does not exist in Foxhound. Each cut is named with its reason, so a cut is a
// decision in this file and never a silent omission.
const RECOVA_H3S: Record<string, string[]> = {
  platform: [
    "How Foxhound works",
    "Connecting your Stripe account",
    "Disconnecting Stripe",
    "Initial setup",
    "Sender name",
    "Reply-to email",
    "Brand voice",
    "What happens when your first payment fails",
    "Expiring card alerts",
    "Win-back sequences",
    "Weekly digest",
    "Slack notifications",
    "Free lost-revenue audit",
    "Email settings",
    "Brand voice",
    "Merchant context",
    "Notifications",
    "Team",
    "Inviting a team member",
    "Removing a team member",
    "Roles",
    "Billing and subscription",
    "Cancellation",
    "Account deletion",
  ],
  audit: ["Failed invoices", "Expiring cards", "Open disputes", "Business health"],
  recovery: [
    "Reading the payments list",
    "Filtering and search",
    "Rows per page",
    "Understanding payment statuses",
    "Reading a payment detail page",
    "Manual actions on a payment",
    "Bulk actions",
    "Exporting to CSV",
    "How sequences are built by decline type",
    "Reading the sequence performance page",
    "How recovery emails are written",
    "Stat cards",
    "Date range filter",
    "ROI widget",
    "Recovery rate benchmark",
    "Webhook health indicator",
    "A payment is not being detected",
    "Emails are not sending",
    "Recovery rate seems low",
    "A customer says they did not receive an email",
    // CUT: "Contact support". The address Recova prints is its own, and
    // Foxhound's support inbox is not confirmed working (RULES.md 3.22, 7.6).
  ],
  disputes: [
    "How Foxhound handles disputes",
    // CUT: "The triage score", "Fight recommendations", "Accept
    // recommendations". Nothing outside the demo seeder writes
    // disputes.triage_recommendation. CUT: "Dispute reasons", whose content is a
    // 75% platform win rate Foxhound has no history for.
    "What Foxhound includes",
    "File uploads",
    "Auto-submit",
    "Deadlines",
    // CUT from Part 6: "Auto-submit" (never built, RULES.md 5.6), "Product
    // description" and "Ships physical goods" (no disputes settings page).
  ],
  intelligence: [
    "The 0-100 score",
    "Score thresholds and colors",
    // CUT: "Seven action types". ai_recommended_actions has no writer.
    // CUT from Part 7: "Weekly narrative email" (no weekly Intelligence cron).
    "Health alert",
  ],
};

describe("J73 PLANT 1: Recova's Part structure, heading for heading", () => {
  it("the fixture is non-empty, so an empty loop cannot pass", () => {
    expect(DOC_GUIDES.map((g) => g.slug)).toEqual(["platform", "audit", "recovery", "disputes", "intelligence"]);
  });

  for (const [slug, parts] of Object.entries(RECOVA_PARTS)) {
    it(`${slug}: the Parts are Recova's, in Recova's order`, () => {
      expect(guide(slug).sections.map((s) => s.heading)).toEqual(parts);
    });
  }

  for (const [slug, h3s] of Object.entries(RECOVA_H3S)) {
    it(`${slug}: every kept Recova H3 is present, in Recova's order`, () => {
      // A subsequence check: Foxhound may carry an H3 Recova does not (an
      // addition is not a gap, RULES.md 1.2), never drop or reorder one of
      // Recova's that it keeps.
      const actual = h3sOf(slug);
      let at = 0;
      for (const h of h3s) {
        const found = actual.indexOf(h, at);
        expect(found, `${slug} is missing or misorders "${h}"`).toBeGreaterThanOrEqual(0);
        at = found + 1;
      }
    });
  }

  it("the page heading and lead are Recova's, the card title and description stay the index's", () => {
    expect(guide("platform").heading).toBe("Platform setup");
    expect(guide("recovery").heading).toBe("Recovery sequences");
    expect(guide("audit").heading).toBe("Audit");
    expect(guide("platform").lead).toBe(
      "Connecting Stripe, configuring settings, managing your team, and understanding billing.",
    );
    expect(guide("recovery").lead).toBe(
      "Managing failed payments, reading sequences, understanding your dashboard, and troubleshooting.",
    );
    expect(guide("audit").lead).toBe("A free Stripe diagnostic that shows what your account is leaking. No signup required.");
    // The index card keeps its own words (J17, M17).
    expect(guide("platform").title).toBe("Platform");
  });
});

describe("J73 PLANT 2: every claim is Foxhound's engine, not Recova's", () => {
  it("RECOVERY: the date range buttons are the dashboard's own", () => {
    const text = textOf("recovery");
    // The button prints the raw key (RangeSelector renders {r}), so "all" is
    // lower case here too (review of 6835e6c).
    expect(text).toContain(`${RECOVERY_RANGES.slice(0, -1).join(", ")} and ${RECOVERY_RANGES.at(-1)} buttons`);
    expect(text).not.toContain("and All buttons");
  });

  it("RECOVERY: the range moves exactly the panels the dashboard feeds from it, and the timing chart stays at 30 days", () => {
    // app/routes/app/recovery/index.tsx: RecoveryQueuePanel and PaymentsPreview
    // take w={data}; RecoveryTimingChart and the stat cards take w={data30d}.
    const text = textOf("recovery");
    const route = read("app/routes/app/recovery/index.tsx");
    expect(route).toContain("<RecoveryQueuePanel w={data}");
    expect(route).toContain("<PaymentsPreview w={data}");
    expect(route).toContain("<RecoveryTimingChart w={data30d}");
    expect(text).toContain("the recovery queue and the payments preview");
    expect(text).toContain("The recovery timing chart stays on the last 30 days");
  });

  it("RECOVERY: the network early retry is read from the schedule", () => {
    const first = RECOVERY_SCHEDULES.network[0]!;
    expect(first.stepType.startsWith("retry_")).toBe(true);
    expect(textOf("recovery")).toContain(`${first.offsetHours} hours`);
  });

  it("RECOVERY: every decline code the guide names classifies into the category it is shown under", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocWidget, { name: "decline-categories" })));
    for (const [category, label] of Object.entries(DECLINE_CATEGORY_LABELS)) {
      const start = html.indexOf(`data-category="${category}"`);
      expect(start, `${label} card`).toBeGreaterThanOrEqual(0);
      const end = html.indexOf("data-category=", start + 1);
      const card = html.slice(start, end === -1 ? undefined : end);
      const codes = [...card.matchAll(/<code[^>]*>([a-z_]+)<\/code>/g)].map((m) => m[1]!);
      if (category !== "unknown") expect(codes.length, `${category} names codes`).toBeGreaterThan(0);
      for (const code of codes) expect(classifyDecline(code), code).toBe(category);
    }
  });

  it("DISPUTES: the deadline bands are the dashboard's constants, and no reminder email is promised", () => {
    const text = textOf("disputes");
    expect(text).toContain(`${DEADLINE_URGENT_DAYS} days or fewer`);
    expect(text).toContain(`${DEADLINE_SOON_DAYS} days or fewer`);
    expect(text).not.toMatch(/reminder emails at/i);
  });

  it("DISPUTES: evidence names only what Foxhound stages, never Recova's five sources", () => {
    // lib/disputes/evidence.ts builds product_description, service_date and
    // customer_communication from the recovery the charge belongs to, plus an
    // AI summary in uncategorized_text. Nothing reads Radar, AVS, CVV or 3DS.
    const text = textOf("disputes");
    for (const absent of [/radar/i, /3D Secure/i, /\bAVS\b/, /\bCVV\b/, /prior charge/i, /five sources/i]) {
      expect(text).not.toMatch(absent);
    }
    expect(text).toMatch(/plan/i);
    expect(text).toMatch(/recovery email/i);
  });

  it("DISPUTES: customer communication is the linked payment's executed steps, not every email to the customer", () => {
    // resolveDisputedRecovery (app/lib/webhooks/process.ts) reads the steps of
    // the ONE failed payment on the disputed charge's invoice, and
    // formatCommunicationLog lists every executed step, retries included.
    const text = textOf("disputes");
    expect(read("app/lib/disputes/evidence.ts")).toContain("${c.stepType} sent ");
    expect(text).not.toMatch(/every recovery email sent to that customer/i);
    expect(text).not.toContain("the recovery emails that customer was sent");
    expect(text).toContain("each step that ran, retries included, with when an email was opened and clicked");
  });

  it("DISPUTES: there is no Accept control, so the guide does not describe clicking one", () => {
    expect(textOf("disputes")).not.toMatch(/Click Accept dispute/i);
    expect(textOf("disputes")).toContain("There is no auto-submit toggle. There never has been.");
  });

  it("INTELLIGENCE: the thresholds are healthScoreBand's, and the badges agree", () => {
    const text = textOf("intelligence");
    expect(text).toContain(`below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`);
    expect(text).toContain(`${WATCH_CEILING} and above`);
    expect(text).not.toMatch(/34-66|67-100|0-33/);
    const pill = (score: number) => renderToStaticMarkup(createElement(HealthScoreBadge, { score }));
    expect(pill(HEALTH_SCORE_AT_RISK_THRESHOLD - 2)).toContain('data-tone="crit"');
    expect(pill(HEALTH_SCORE_AT_RISK_THRESHOLD)).toContain('data-tone="warn"');
    expect(pill(WATCH_CEILING)).toContain('data-tone="ok"');
  });

  it("INTELLIGENCE: the factors behind a score are on the customer's own page, not the customers list", () => {
    const text = textOf("intelligence");
    expect(read("app/routes/app/intelligence/customer.tsx")).toContain(">Factors</p>");
    expect(text).not.toContain("shows the signals that moved each score");
    expect(text).toContain("Each customer's own page lists the factors that moved their score");
  });

  it("INTELLIGENCE: the band edge example is an edge", () => {
    const text = textOf("intelligence");
    expect(text).not.toContain("a 38 included");
    expect(text).toContain(`${HEALTH_SCORE_AT_RISK_THRESHOLD - 1} reads as at risk and ${HEALTH_SCORE_AT_RISK_THRESHOLD} as watch`);
  });

  it("INTELLIGENCE: no claim that the analytics are free, because every Intelligence page is entitlement-gated", () => {
    expect(read("app/routes/app/intelligence/index.tsx")).toContain("isIntelligenceEntitled");
    expect(textOf("intelligence")).not.toMatch(/at no charge|stays free/i);
  });

  it("AUDIT: the anonymous lookback is the engine's constant", () => {
    expect(textOf("audit")).toContain(`${AUDIT_LOOKBACK_DAYS} days`);
    expect(textOf("audit")).not.toMatch(/30%/);
  });

  it("PLATFORM: an invite is a link Foxhound shows you, not an email it sends", () => {
    // app/routes/app/settings/team.tsx returns inviteUrl for the owner to share;
    // nothing sends an invite email.
    expect(read("app/routes/app/settings/team.tsx")).toContain("Share this link");
    expect(textOf("platform")).not.toMatch(/receive an email with a link|get an email/i);
  });

  it("PLATFORM: notifications each have their own switch, and Slack must be switched on", () => {
    const text = textOf("platform");
    expect(text).not.toContain("which is also how you turn either one off");
    expect(text).toMatch(/switch on Slack notifications/i);
  });

  it("every in-guide link points at a route Foxhound serves", () => {
    const routes = read("app/routes.ts");
    const links = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .flatMap((b) => {
        if (typeof b === "string") return [];
        const runs: (string | DocInline[])[] =
          b.kind === "p" ? [b.body] : b.kind === "note" || b.kind === "tip" ? [b.body] : b.kind === "steps" || b.kind === "list" ? b.items : b.kind === "table" ? b.rows.flat() : [];
        return runs.flatMap((r) => (typeof r === "string" ? [] : r.flatMap((n) => (typeof n !== "string" && "to" in n ? [n.to] : []))));
      });
    expect(links.length).toBeGreaterThan(3);
    for (const to of links.filter((l) => l.startsWith("/"))) {
      const [first, ...rest] = to.slice(1).split("/");
      const last = rest.at(-1) ?? first!;
      expect(routes, `${to} is not a route`).toContain(`"${to.startsWith("/docs/") ? ":slug" : last}"`);
    }
  });
});

describe("J73 PLANT 3: Capsomer's parts, teal, the five sizes", () => {
  const render = (slug: string) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(DocGuidePage as never, {
          loaderData: { guide: guide(slug), siteUrl: "https://foxhoundapp.test" },
          params: { slug },
          matches: [],
        }),
      ),
    );

  for (const slug of Object.keys(RECOVA_PARTS)) {
    it(`${slug}: rendered from Capsomer's breadcrumb, panel and tables, under the teal family`, () => {
      const html = render(slug);
      expect(html).toContain('data-family="teal"');
      expect(html).toContain("cap-breadcrumb");
      expect(html).toContain("cap-panel");
      if (guide(slug).sections.flatMap((s) => s.body).some((b) => typeof b !== "string" && b.kind === "table")) {
        expect(html).toContain("cap-table");
      }
      expect(html).not.toMatch(/amber/);
      // The five standard sizes only (RULES.md 5.2).
      for (const off of ["text-item-title", "text-page-title", "text-caption", "text-copy", "text-subhead"]) {
        expect(html, off).not.toContain(off);
      }
      expect(html).not.toMatch(/text-\[\d/);
    });
  }

  it("every widget renders from Capsomer parts and none of them is orphaned", () => {
    for (const name of DOC_WIDGET_NAMES) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocWidget, { name })));
      expect(html, name).toMatch(/cap-(panel|pill|table|status|tile)/);
      for (const off of ["text-item-title", "text-caption", "amber"]) expect(html, `${name} ${off}`).not.toContain(off);
    }
  });

  it("the sequence pictures are one per category, read from RECOVERY_SCHEDULES", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocWidget, { name: "sequence-timelines" })));
    for (const [category, steps] of Object.entries(RECOVERY_SCHEDULES)) {
      const label = DECLINE_CATEGORY_LABELS[category as keyof typeof DECLINE_CATEGORY_LABELS];
      expect(html).toContain(`${label}: ${steps.length} ${steps.length === 1 ? "step" : "steps"}`);
    }
  });
});
