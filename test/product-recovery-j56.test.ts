import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { isBillableRecoveryRow } from "~/lib/billing/billable-predicates";
import { recoveryFeeCents } from "~/lib/billing/fees";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  BILLABLE_ATTRIBUTION_KINDS,
  EXPIRING_CARD_DAYS_AHEAD,
  RECOVERY_FEE_BPS,
  type DeclineCategory,
} from "~/lib/constants";
import { recoveryRateBand } from "~/lib/dashboard/recovery-rate";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";
import { formatMoney } from "~/lib/money-format";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS, formatStepType } from "~/lib/recovery/labels";
import { isRetryStep, RECOVERY_SCHEDULES, WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import routes from "~/routes";
import { buildRecoveryPreview } from "~/lib/marketing/recovery-preview.server";
import RecoveryProductPage, { loader } from "~/routes/products/recovery";

// J56 (job_95c1374a28ad), the Recovery spoke. Recova's spec, read whole at
// HEAD: app/(marketing)/product/recovery/page.tsx (blob ec4aded8),
// components/product/ProductSections.tsx (ba3aed7c), ProductFAQ.tsx (7c08a5a2),
// RecoveryDashboardPreview.tsx (565b772c) with its StatCards (b1923468) and
// ROIWidget (549b89ef), RecoveryPaymentsPreview.tsx (da19edf0) with its
// PaymentsTable (3dc398a2) and PaymentRow (0d2e1f52), CategoryPill.tsx
// (c7dc96f1) and SequenceTimeline.tsx (aa6a85fc).
//
// These read the RENDERED page, fed by the route's own loader, so a value
// that never reaches a reader cannot pass. Every expected number is worked
// out here a second way, straight from the demo seed and the engine
// constants, never read back from the module under test.

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    throw new Error("unexpected context key");
  },
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

async function load(): Promise<LoaderData> {
  return loader({
    context: fakeContext,
    request: new Request("https://foxhoundapp.com/products/recovery"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
}

function render(loaderData: LoaderData): string {
  const Page = RecoveryProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/products/recovery"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and entities for the characters this page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The asOf instant the loader built its preview at, so this file rebuilds the same seed. */
function asOf(data: LoaderData): Date {
  const iso = (data as unknown as { preview?: { asOf?: string } }).preview?.asOf;
  expect(iso, "the loader names the instant its preview was built at").toBeTypeOf("string");
  return new Date(iso as string);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CATEGORIES = Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[];
const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
const SEQUENCE_DAYS = Math.round(
  Math.max(...CATEGORIES.flatMap((c) => RECOVERY_SCHEDULES[c].map((s) => s.offsetHours))) / 24,
);
const DISTINCT_SEQUENCES = new Set(CATEGORIES.map((c) => JSON.stringify(RECOVERY_SCHEDULES[c]))).size;

interface RouteEntry {
  path?: string;
  index?: boolean;
  children?: RouteEntry[];
}

function routePaths(entries: RouteEntry[], parent = "", out = new Set<string>()): Set<string> {
  for (const e of entries) {
    let path = parent;
    if (e.path) {
      path = `${parent}/${e.path.replace(/^\/+|\/+$/g, "")}`;
      out.add(path);
    } else if (e.index) {
      out.add(parent === "" ? "/" : parent);
    }
    if (e.children) routePaths(e.children, path, out);
  }
  return out;
}

describe("/products/recovery follows Recova's sections, in Recova's order (J56)", async () => {
  const data = await load();
  const html = render(data);
  const body = text(html);

  it("renders the hero, How it works, the three feature blocks, Pricing, Questions and the closing block in order", () => {
    const marks = [
      "20% of what Foxhound recovers.",
      "How it works",
      "What you see after connecting",
      "Smarter than Smart Retries",
      "Full visibility",
      "Your failed payments, classified and in sequence.",
      "Pricing",
      "Questions",
      "See what is currently unrecovered.",
    ];
    let at = -1;
    for (const m of marks) {
      const next = body.indexOf(m, at + 1);
      expect(next, `"${m}" comes after the mark before it`).toBeGreaterThan(at);
      at = next;
    }
  });

  it("carries Recova's three feature blocks: eyebrows, titles, and the lifted middle block", () => {
    expect(body).toContain(
      `${COUNT_WORDS[CATEGORIES.length]} categories. ${COUNT_WORDS[DISTINCT_SEQUENCES]} different sequences.`,
    );
    expect(body).toContain("Every payment. Every step. Every timestamp.");
    expect(body).toContain("Your failed payments, classified and in sequence.");
    // The section label and the third eyebrow are the same words in Recova.
    expect(body.split("What you see after connecting").length - 1).toBe(2);
    expect(html).toMatch(/data-block="lifted"/);
    expect(html).toMatch(/data-block="tall"/);
  });

  it("links Smart Retries to Stripe's own page, in a new tab with noopener", () => {
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/stripe\.com\/docs\/billing\/revenue-recovery\/smart-retries"[^>]*rel="noopener noreferrer"[^>]*>Smart Retries/,
    );
  });

  it("names no Recova and states every number from the engine", () => {
    expect(html).not.toMatch(/recova/i);
    expect(body).toContain(`${SEQUENCE_DAYS}-day sequences across ${CATEGORIES.length} decline categories`);
    expect(body).toContain(`${RECOVERY_FEE_BPS / 100}% of Foxhound-attributed recoveries`);
    const winbackDays = Math.round(WIN_BACK_SCHEDULE[WIN_BACK_SCHEDULE.length - 1].offsetHours / 24);
    expect(body).toContain(`Win-back sequences on cancellation (${WIN_BACK_SCHEDULE.length} steps over ${winbackDays} days)`);
    expect(body).toContain(`Expiring card alerts (daily, ${EXPIRING_CARD_DAYS_AHEAD}-day window)`);
    // The quality gate is a deterministic brand-voice check, not an AI audit.
    expect(body).toContain("AI-written emails with a quality check pass");
    expect(body).not.toMatch(/AI quality audit/);
    // The hero and block 1 count the same sequences.
    expect(body).toContain(
      `${COUNT_WORDS[CATEGORIES.length]} decline categories handled with ${COUNT_WORDS[DISTINCT_SEQUENCES].toLowerCase()} different sequences.`,
    );
  });

  it("does not offer the custom email body editor Foxhound does not build", () => {
    expect(body).not.toMatch(/custom email body/i);
  });
});

describe("the category sequences preview reads RECOVERY_SCHEDULES (J56)", async () => {
  const html = render(await load());

  it("draws one timeline per scheduled category, in schedule order, step for step", () => {
    const order = CATEGORIES.map((c) => html.indexOf(`data-category="${c}"`));
    for (const [i, at] of order.entries()) expect(at, `${CATEGORIES[i]} is drawn`).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    for (const c of CATEGORIES) {
      const start = html.indexOf(`data-category="${c}"`);
      const list = html.slice(html.indexOf("<ol", start), html.indexOf("</ol>", start));
      const steps = [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
      const want = RECOVERY_SCHEDULES[c].map((s) => (isRetryStep(s.stepType) ? "Retry" : "Email"));
      expect(steps.length, `${c} has every step`).toBe(want.length);
      steps.forEach((s, i) => expect(s.startsWith(want[i]), `${c} step ${i + 1} is ${want[i]}`).toBe(true));
      const block = text(html.slice(start, html.indexOf("</ol>", start)));
      const n = RECOVERY_SCHEDULES[c].length;
      expect(block).toContain(`${DECLINE_CATEGORY_LABELS[c]} sequence`);
      expect(block).toContain(`${DECLINE_CATEGORY_LABELS[c]}: ${n} ${n === 1 ? "step" : "steps"}`);
    }
  });
});

describe("the dashboard preview is the demo seed through Foxhound's own math (J56)", async () => {
  const data = await load();
  const html = render(data);
  const body = text(html);
  const demo = lazy(() => {
    const now = asOf(data);
    const seed = buildRecoverySeed(DEMO_ACCOUNT_ID, buildTeamflowBase(now), now);
    const failures = seed.failedPayments.filter((f) => !f.isRenewalNoise && !f.deletedAt);
    return { now, nowMs: now.getTime(), seed, failures, failureIds: new Set(failures.map((f) => f.id)) };
  });

  it("shows Recova's three primary cards with the demo's figures", () => {
    const { nowMs, seed, failures, failureIds } = demo();
    const recovered30 = seed.recoveredPayments
      .filter((r) => failureIds.has(r.failedPaymentId) && r.recoveredAt.getTime() >= nowMs - 30 * DAY_MS)
      .reduce((s, r) => s + r.amountCents, 0);
    const atRisk = failures.filter((f) => f.status === "active").reduce((s, f) => s + (f.amountCents ?? 0), 0);
    const cohort = failures.filter((f) => (f.detectedAt as Date).getTime() >= nowMs - 30 * DAY_MS);
    const recoveredIds = new Set(seed.recoveredPayments.map((r) => r.failedPaymentId));
    expect(cohort.length, "the demo has failures in the last 30 days").toBeGreaterThan(0);
    const rate = Math.round((cohort.filter((f) => recoveredIds.has(f.id ?? "")).length / cohort.length) * 100);

    expect(body).toMatch(new RegExp(`Recovered \\(30d\\) ${escape(formatMoney(recovered30, "usd"))}`));
    expect(body).toMatch(new RegExp(`Currently at risk ${escape(formatMoney(atRisk, "usd"))}`));
    expect(body).toMatch(new RegExp(`Recovery rate ${rate}% ${escape(recoveryRateBand(rate))}`));
  });

  it("shows the ROI widget's two columns with Foxhound's fee on billable recoveries", () => {
    const { now, nowMs, seed } = demo();
    const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const billable = seed.recoveredPayments.filter((r) => isBillableRecoveryRow(r, nowMs));
    const all = billable.reduce((s, r) => s + r.amountCents, 0);
    // This month: every Foxhound-attributed recovery since the 1st, matured or
    // not, never refunded, disputed or deleted.
    const month = seed.recoveredPayments
      .filter(
        (r) =>
          (BILLABLE_ATTRIBUTION_KINDS as readonly string[]).includes(r.attributionKind ?? "") &&
          r.refundedAt == null &&
          r.disputedAt == null &&
          r.deletedAt == null &&
          r.recoveredAt.getTime() >= first,
      )
      .reduce((s, r) => s + r.amountCents, 0);
    expect(all, "the demo has billable recoveries to show").toBeGreaterThan(0);
    const pct = RECOVERY_FEE_BPS / 100;
    const m = (c: number) => escape(formatMoney(c, "usd"));
    expect(body).toMatch(
      new RegExp(
        `This month Recovered by Foxhound ${m(month)} Foxhound fee \\(${pct}%\\) ${m(recoveryFeeCents(month))} You kept ${m(month - recoveryFeeCents(month))}`,
      ),
    );
    expect(body).toMatch(
      new RegExp(
        `All time Total recovered by Foxhound ${m(all)} Total fees paid ${m(recoveryFeeCents(all))} Net to you ${m(all - recoveryFeeCents(all))}`,
      ),
    );
  });

  it("never shows the demo earning nothing this month (mid-month, the seed has attributed recoveries)", () => {
    const preview = buildRecoveryPreview(new Date("2026-10-14T12:00:00Z"));
    expect(preview.roi.thisMonth.recovered).not.toBe("$0.00");
    expect(preview.roi.thisMonth.fee).not.toBe("$0.00");
  });

  it("draws no chart Recova does not draw here", () => {
    expect(html).not.toMatch(/<svg[^>]*role="img"/);
  });
});

describe("the payments preview is the demo seed's most recent failures (J56)", async () => {
  const data = await load();
  const html = render(data);
  const demo = lazy(() => {
    const now = asOf(data);
    const seed = buildRecoverySeed(DEMO_ACCOUNT_ID, buildTeamflowBase(now), now);
    const failures = seed.failedPayments
      .filter((f) => !f.isRenewalNoise && !f.deletedAt)
      .sort((a, b) => (b.detectedAt as Date).getTime() - (a.detectedAt as Date).getTime());
    return { seed, failures };
  });
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const rows = [...table.slice(table.indexOf("<tbody")).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);

  it("heads the table with Recova's title, count line, View all and six columns", () => {
    const { failures } = demo();
    const active = failures.filter((f) => f.status === "active").length;
    expect(text(html)).toContain(`Failed payments ${failures.length} total · ${active} active View all`);
    const heads = [...table.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
    expect(heads).toEqual(["Customer", "Amount", "Decline", "Steps", "Status", "Detected"]);
    expect(html).toMatch(/<a [^>]*href="\/audit"[^>]*>View all<\/a>/);
  });

  it("lists Recova's eight rows, newest first, each with its steps and the tab word for its status", () => {
    const { seed, failures } = demo();
    expect(rows).toHaveLength(8);
    rows.forEach((row, i) => {
      const f = failures[i];
      const cells = text(row);
      expect(cells.startsWith(f.customerName ?? f.customerEmail), `row ${i + 1} is ${f.customerName}`).toBe(true);
      expect(cells).toContain(formatMoney(f.amountCents as number, f.currency as string));
      expect(cells).toContain(f.declineCode as string);
      const steps = seed.recoverySteps.filter((s) => s.failedPaymentId === f.id);
      const done = steps.filter((s) => s.executedAt).length;
      // Intake writes the whole schedule up front, so the total is the
      // category's schedule even when the payment recovered part way.
      expect(cells).toContain(`${done}/${RECOVERY_SCHEDULES[f.declineCategory as DeclineCategory].length}`);
      const next = steps.find((s) => !s.executedAt && !s.result);
      if (next) expect(cells).toContain(`Next: ${formatStepType(next.stepType)}`);
      expect(cells).toContain(FAILED_PAYMENT_STATUS_LABELS[f.status as string]);
    });
  });

  it("marks a repeat customer as Recova does, with its failure count", () => {
    const { failures } = demo();
    const totals = new Map<string, number>();
    for (const f of failures) totals.set(f.stripeCustomerId, (totals.get(f.stripeCustomerId) ?? 0) + 1);
    rows.forEach((row, i) => {
      const n = totals.get(failures[i].stripeCustomerId) ?? 0;
      if (n > 1) expect(text(row)).toContain(`${n}x failure`);
      else expect(text(row)).not.toMatch(/x failure/);
    });
  });

  it("links nowhere a person cannot follow: no per-row link to a page that does not exist", () => {
    expect(table).not.toMatch(/<a /);
  });
});

describe("the page is built from Capsomer's parts, teal, on the five sizes (J56)", async () => {
  const html = render(await load());

  it("sits in Capsomer's teal family with Foxhound's neutrals", () => {
    expect(html).toMatch(/^<div class="fh-cap[^"]*" data-family="teal"/);
  });

  it("draws every call to action as Capsomer's primary button", () => {
    const ctas = [...html.matchAll(/<a [^>]*>Run your free audit<\/a>/g)].map((m) => m[0]);
    expect(ctas).toHaveLength(3);
    for (const a of ctas) {
      expect(a).toMatch(/class="cap-btn"/);
      expect(a).toContain('data-variant="primary"');
      expect(a).toContain('href="/audit"');
    }
  });

  it("asks each question in Capsomer's disclosure, one open at a time", () => {
    const items = [...html.matchAll(/<details class="cap-disclosure" name="([^"]+)"[^>]*><summary>([^<]+)<\/summary>/g)];
    expect(items.map((m) => m[2].replace(/&#x27;/g, "'"))).toEqual([
      "What counts as a recovered payment?",
      "What happens if a customer replies to a recovery email?",
      "Can I pause or cancel a sequence?",
    ]);
    expect(new Set(items.map((m) => m[1])).size).toBe(1);
  });

  it("puts the payments table in Capsomer's labelled, focusable scroll region", () => {
    expect(html).toMatch(/<div class="cap-table-wrap" role="region" aria-labelledby="[^"]+" tabindex="0"><table class="cap-table"/);
  });

  it("lets a keyboard reach the tall block's own scroll area", () => {
    const tall = html.slice(html.indexOf('data-block="tall"'));
    expect(tall).toMatch(/<div [^>]*role="region"[^>]*tabindex="0"[^>]*class="[^"]*overflow-y-auto/);
  });

  it("carries no amber anywhere", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const FIVE = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
    const COLOUR = /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|green|success-text|error-text|caution|center|left|right)$/;
    expect(html).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (base.startsWith("text-") && !COLOUR.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE.has(s), `${s} is one of the five`).toBe(true);
  });

  it("points every internal link at a route that exists", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/audit"), "the matcher finds a known route").toBe(true);
    const hrefs = [...html.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      const known = paths.has(h) || [...paths].some((p) => p.includes(":") && new RegExp(`^${p.replace(/:[^/]+/g, "[^/]+")}$`).test(h));
      expect(known, `${h} is a route`).toBe(true);
    }
  });

  it("keeps the SpeakableSpecification pointing at classes the page carries", () => {
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const json = JSON.parse(ld) as { speakable: { cssSelector: string[] } };
    expect(json.speakable.cssSelector.length).toBe(3);
    for (const sel of json.speakable.cssSelector) expect(html).toContain(sel.slice(1));
  });
});

function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
