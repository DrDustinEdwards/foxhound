import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  INTELLIGENCE_MAX_CUSTOMERS_SCANNED,
  INTELLIGENCE_NARRATIVE_TOP_N,
  INTELLIGENCE_PRICE_CENTS,
} from "~/lib/constants";
import { CRON_JOBS } from "~/lib/cron/registry";
import { DEMO_ACCOUNT_ID, DEMO_MEMBER_EMAIL } from "~/lib/demo/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import { buildIntelligenceSeed } from "~/lib/demo/intelligence-seed";
import { buildNarrativeSeed } from "~/lib/demo/narratives-seed";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import * as risk from "~/lib/intelligence/risk";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import routes from "~/routes";
import IntelligenceProductPage, { loader } from "~/routes/products/intelligence";

// J58 (job_b091fc0d979e), the Intelligence spoke, row M9. Recova's spec, read
// whole at HEAD: app/(marketing)/product/intelligence/page.tsx (blob
// 4f258429), components/product/ProductSections.tsx (ba3aed7c),
// ProductFAQ.tsx (7c08a5a2), IntelligenceDashboardPreview.tsx (11972333) with
// the MRRStatCards (2920fa3b) and PlanBreakdown (65b5674f) it mounts,
// components/docs/IntelligenceCustomerTable.tsx (6ae7c73f) with
// HealthScoreBadge (f25f29d8), components/docs/ChurnRiskSummary.tsx (ba1fbb51)
// and components/intelligence/IntegrityLayerBanner.tsx (1614dfaf).
//
// These read the RENDERED page, fed by the route's own loader. Every expected
// number is worked out here a second way, straight from the demo seed and the
// engine constants, never read back from the modules under test.

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
    request: new Request("https://foxhoundapp.com/product/intelligence"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
}

function render(loaderData: LoaderData): string {
  const Page = IntelligenceProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/product/intelligence"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and entities for the characters this page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The page's words, previews included: a claim in a preview's caption is
 *  still a claim. */
function copyOf(html: string): string {
  return text(html);
}

/** The asOf instant the loader built its preview at, so this file rebuilds the same seed. */
function asOf(data: LoaderData): Date {
  const iso = (data as unknown as { preview?: { asOf?: string } }).preview?.asOf;
  expect(iso, "the loader names the instant its preview was built at").toBeTypeOf("string");
  return new Date(iso as string);
}

/** The demo account's Intelligence rows, built here from the same pure seed
 *  builders the demo reset runs (app/lib/demo/seed.ts). */
function demoSeed(now: Date) {
  const customers = buildTeamflowBase(now);
  const recovery = buildRecoverySeed(DEMO_ACCOUNT_ID, customers, now);
  const disputes = buildDisputesSeed(DEMO_ACCOUNT_ID, now, DEMO_MEMBER_EMAIL);
  const intelligence = buildIntelligenceSeed({
    accountId: DEMO_ACCOUNT_ID,
    now,
    customers,
    failedPayments: recovery.failedPayments,
    recoveredPayments: recovery.recoveredPayments,
    disputes: disputes.disputes,
  });
  const snapshots = [...intelligence.mrrSnapshots].sort(
    (a, b) => (a.snapshotDate as Date).getTime() - (b.snapshotDate as Date).getTime(),
  );
  return { intelligence, latest: snapshots[snapshots.length - 1], narrative: buildNarrativeSeed(DEMO_ACCOUNT_ID, now) };
}

/** The band a score falls in, from the two engine thresholds. */
function bandOf(score: number): "at_risk" | "watch" | "healthy" {
  if (score < HEALTH_SCORE_AT_RISK_THRESHOLD) return "at_risk";
  if (score < WATCH_CEILING) return "watch";
  return "healthy";
}

const PRICE = formatMoneyShort(INTELLIGENCE_PRICE_CENTS, "usd");
const COUNT_WORD = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/** Every signal the engine can emit, found by driving computeHealthScore with
 *  inputs that move every factor, not read from a list. */
function emittedSignals(): string[] {
  const nowMs = Date.UTC(2026, 9, 15);
  const adverse = risk.computeHealthScore({
    nowMs,
    subscriptionAgeDays: 720,
    planChangeCount: 2,
    seatChangeCount: 1,
    intervalSwitchCount: 1,
    paymentLatencyDriftDays: 5,
    refundCount: 1,
    disputeCount: 1,
    recoverySignals: { failedPaymentCount: 2 } as never,
    engagementSignals: null,
  });
  return adverse.factors.map((f) => f.signal).sort();
}

function signalLabels(): string[] {
  const labels = (risk as unknown as { HEALTH_SIGNAL_LABELS?: Record<string, string> }).HEALTH_SIGNAL_LABELS;
  expect(labels, "risk.ts names each signal it scores").toBeTypeOf("object");
  return Object.values(labels as Record<string, string>);
}

function listOf(words: string[]): string {
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

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

function tableIn(html: string): string {
  const start = html.indexOf("<table");
  expect(start, "a table is drawn").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</table>", start));
}

function heads(table: string): string[] {
  return [...table.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
}

function bodyRows(table: string): string[] {
  const tbody = table.slice(table.indexOf("<tbody"));
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
}

/** One feature block's markup, by its data-block position. */
function block(html: string, i: number): string {
  const parts = html.split(/data-block="[a-z]+"/);
  expect(parts.length, "three feature blocks").toBe(4);
  return parts[i + 1];
}

describe("/product/intelligence follows Recova's sections, in Recova's order (J58)", async () => {
  const html = render(await load());
  const body = text(html);

  it("renders the hero, How it works, the three feature blocks, Pricing, Questions and the closing block in order", () => {
    const marks = [
      "Know which customers are about to churn.",
      "How it works",
      "Intelligence scores every customer nightly",
      "MRR data updates monthly",
      "What you see after connecting",
      "MRR trends, plan breakdown, monthly narrative.",
      "0-100 per customer",
      "MRR at risk",
      "See your at-risk MRR by band.",
      "Pricing",
      "Questions",
      "Your highest-value customers are telling you they are at risk.",
    ];
    let at = -1;
    for (const m of marks) {
      const next = body.indexOf(m, at + 1);
      expect(next, `"${m}" comes after the mark before it`).toBeGreaterThan(at);
      at = next;
    }
  });

  it("draws Recova's three blocks as plain, lifted, plain", () => {
    const kinds = [...html.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["plain", "lifted", "plain"]);
  });

  it("keeps Recova's headline, and its price line with the price read from the engine", () => {
    expect(html).toMatch(/<h1[^>]*>Know which customers are about to churn\.\nBefore they do\.<\/h1>/);
    expect(body).toContain(`${PRICE}/mo · Flat subscription · Account-wide`);
    expect(body).toContain(`${PRICE} per month, account-wide`);
  });

  it("names no Recova", () => {
    expect(html).not.toMatch(/recova/i);
  });

  it("puts every call to action on the free audit, and the guide on /docs/intelligence", () => {
    const ctas = [...html.matchAll(/<a [^>]*>Run your free audit<\/a>/g)].map((m) => m[0]);
    expect(ctas).toHaveLength(3);
    for (const a of ctas) expect(a).toContain('href="/audit"');
    expect(html).toMatch(/<a [^>]*href="\/docs\/intelligence"[^>]*>Read the guide/);
    expect(body).toContain("The free audit shows your current MRR and involuntary churn rate");
  });

  it("carries no section Recova's page does not have: no free-tier block, no fourth question", () => {
    expect(body).not.toMatch(/free for every Recovery merchant/i);
    expect(body).not.toMatch(/Is the risk score a validated prediction/);
    expect(body).not.toMatch(/Is any of Intelligence free/);
  });
});

describe("the copy says only what Foxhound computes (J58)", async () => {
  const html = render(await load());
  const body = text(html);
  const copy = copyOf(html);

  it("names the score's signals from the engine, every one the engine can emit and no other", () => {
    const labels = signalLabels();
    const keys = Object.keys((risk as unknown as { HEALTH_SIGNAL_LABELS: Record<string, string> }).HEALTH_SIGNAL_LABELS).sort();
    expect(keys).toEqual(emittedSignals());
    const list = listOf(labels);
    expect(body).toContain(`0-100 health scores per customer, derived from ${list}.`);
    expect(body).toContain(`${COUNT_WORD[labels.length]} signals, ${list}, combine into a 0-100 health score`);
    expect(body).toContain(`The health score is derived from ${COUNT_WORD[labels.length].toLowerCase()} independent signals: ${list}.`);
  });

  it("does not claim Recova's three bands or a customer-value input the score does not have", () => {
    expect(copy).not.toMatch(/engagement health/i);
    expect(copy).not.toMatch(/customer value/i);
    expect(copy).not.toMatch(/MRR percentile/i);
    expect(copy).not.toMatch(/three (independent )?bands/i);
  });

  it("states the baseline the score moves from, read from the engine", () => {
    const baseline = (risk as unknown as { HEALTH_SCORE_BASELINE?: number }).HEALTH_SCORE_BASELINE;
    expect(baseline, "risk.ts exports its baseline").toBeTypeOf("number");
    const neutral = risk.computeHealthScore({
      nowMs: 0,
      subscriptionAgeDays: null,
      planChangeCount: null,
      seatChangeCount: null,
      intervalSwitchCount: null,
      paymentLatencyDriftDays: null,
      refundCount: null,
      disputeCount: null,
      recoverySignals: null,
      engagementSignals: null,
    });
    expect(neutral.score).toBe(baseline);
    expect(body).toContain(`from a baseline of ${baseline}`);
  });

  it("never claims Intelligence changes Recovery timing or feeds Disputes triage (APPROVED-DIFFERENCES, Intelligence entry)", () => {
    expect(copy).not.toMatch(/delays email steps/i);
    expect(copy).not.toMatch(/win-back email at 1 hour/i);
    expect(copy).not.toMatch(/feed(s)? into (Recovery|Disputes)/i);
    expect(copy).not.toMatch(/Intelligence signals (also )?feed/i);
    const answer = /Does Intelligence affect my Recovery sequences\?<\/summary><div class="cap-disclosure-body"><p[^>]*>([^<]+)</.exec(html)?.[1];
    expect(answer, "the question is asked").toBeTypeOf("string");
    const categories = Object.keys(RECOVERY_SCHEDULES).length;
    expect(answer).toMatch(/^No\. /);
    expect(answer).toContain(`one schedule for each of the ${COUNT_WORD[categories].toLowerCase()} decline categories`);
  });

  it("claims no recommended actions, because nothing in Foxhound writes one", () => {
    expect(copy).not.toMatch(/Seven recommend/i);
    expect(copy).not.toMatch(/recommendation types/i);
    expect(copy).not.toMatch(/actionable recommendations/i);
    expect(copy).toContain("A recommended action per customer is not built yet.");
  });

  it("names the MRR cadence the sync really runs at: monthly, never daily or weekly", () => {
    const sync = CRON_JOBS.find((j) => j.name === "intelligence-sync");
    const ai = CRON_JOBS.find((j) => j.name === "intelligence-ai");
    expect(sync?.schedule, "the MRR sync is monthly").toMatch(/^\S+ \S+ 1 \* \*$/);
    expect(ai?.schedule, "the scorer is daily").toMatch(/^\S+ \S+ \* \* \*$/);
    expect(copy).not.toMatch(/Daily from Stripe/);
    expect(copy).not.toMatch(/MRR data updates daily/);
    expect(copy).not.toMatch(/week by week/);
    expect(copy).not.toMatch(/Daily MRR/);
    expect(copy).toContain("Monthly from Stripe");
    expect(copy).toContain("tracked month by month");
    expect(copy).toContain("Monthly MRR snapshots with NRR, GRR, and movement waterfall");
  });

  it("says the narrative is on the dashboard, not in the weekly digest, and the day-over-day change is not computed", () => {
    expect(copy).not.toMatch(/narrative[^.]*weekly digest/i);
    expect(copy).not.toMatch(/Day-over-day MRR delta shown/);
    expect(copy).toContain("Monthly AI narrative summarizing what happened and what to watch, on the dashboard.");
    expect(copy).toContain("A day-over-day MRR change is not computed, because MRR is snapshotted monthly.");
  });

  it("bounds every customer and every at-risk customer by the engine's own caps", () => {
    const cap = INTELLIGENCE_MAX_CUSTOMERS_SCANNED.toLocaleString("en-US");
    expect(copy).toContain(`up to ${cap} per account`);
    expect(copy).toContain(`for each of the ${INTELLIGENCE_NARRATIVE_TOP_N} most at-risk customers`);
    expect(copy).toContain(`Health scores for every Stripe customer, up to ${cap} per account, updated nightly`);
    expect(copy).not.toMatch(/assessment for every at-risk customer/);
  });

  it("lists no pricing point for a feature Foxhound has not built", () => {
    expect(copy).not.toMatch(/Customer timeline/);
    expect(copy).not.toMatch(/Recovery timing and Disputes triage/);
    const points = [...html.matchAll(/<li class="flex items-start gap-3[^"]*"><span aria-hidden="true"[^>]*>[^<]*<\/span><span>([^<]+)<\/span><\/li>/g)].map(
      (m) => m[1].replace(/&#x27;/g, "'"),
    );
    expect(points).toEqual([
      `Health scores for every Stripe customer, up to ${INTELLIGENCE_MAX_CUSTOMERS_SCANNED.toLocaleString("en-US")} per account, updated nightly`,
      `Nightly AI analyst plain-English assessment for the ${INTELLIGENCE_NARRATIVE_TOP_N} most at-risk customers`,
      "Monthly MRR snapshots with NRR, GRR, and movement waterfall",
      "Per-plan breakdown from Stripe subscription data",
      "Churn risk page with MRR by health band",
      "Monthly AI narrative report on the dashboard",
    ]);
  });

  it("asks Recova's three questions, in Recova's order, one open at a time", () => {
    const items = [...html.matchAll(/<details class="cap-disclosure" name="([^"]+)"[^>]*><summary>([^<]+)<\/summary>/g)];
    expect(items.map((m) => m[2])).toEqual([
      "How is the health score calculated?",
      "Does Intelligence affect my Recovery sequences?",
      "What is the difference between Intelligence and the free Audit?",
    ]);
    expect(new Set(items.map((m) => m[1])).size).toBe(1);
  });
});

describe("the dashboard preview is the demo seed through the dashboard's own reads (J58)", async () => {
  const data = await load();
  const html = render(data);
  const seed = lazy(() => demoSeed(asOf(data)));

  it("shows Recova's four stat cards with the demo's MRR and active customers, and says which two are not computed", () => {
    const { latest } = seed();
    const first = text(block(html, 0));
    const mrr = formatMoneyShort(latest.totalMrrCents as number, "usd");
    const active = (latest.activeCustomersCount as number).toLocaleString("en-US");
    expect(first).toContain(
      `MRR ${mrr} Day-over-day Not computed MRR is snapshotted monthly, not daily. Active customers ${active} New MRR (MTD) Not computed MRR is snapshotted monthly, not month to date.`,
    );
    expect(text(html)).toContain(`MRR tracked across ${active} active customers.`);
  });

  it("draws MRR by plan with Enarratio, one bar per plan in the snapshot, largest first", () => {
    const { latest } = seed();
    const plans = Object.entries(latest.perPlanBreakdown as Record<string, number>)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]);
    expect(plans.length, "the demo has plans").toBeGreaterThan(0);
    // Recova's sentence names Starter, Growth and Scale; every plan is one.
    for (const [name] of plans) expect(name).toMatch(/^(Starter|Growth|Scale)\b/);
    const first = block(html, 0);
    expect(first).toContain('data-enarratio="bar"');
    expect(text(first)).toContain("MRR by plan");
    const shown = [...first.matchAll(/<th scope="row"[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(shown).toEqual(plans.map(([name]) => name));
  });

  it("closes with the demo's narrative under its month, as the dashboard shows it", () => {
    const { narrative } = seed();
    const month = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
      narrative.reportMonth as Date,
    );
    const first = text(block(html, 0));
    expect(first).toContain(`${month} narrative ${narrative.narrative}`);
  });
});

describe("the customer table preview is the demo seed, worst health first (J58)", async () => {
  const data = await load();
  const html = render(data);

  it("lists Recova's five rows in the directory's order, with the directory's figures and no Action column", () => {
    const { intelligence } = demoSeed(asOf(data));
    const rows = [...intelligence.customerContext]
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c.healthScore as number) - (b.c.healthScore as number) || a.i - b.i)
      .slice(0, 5)
      .map(({ c }) => c);
    const table = tableIn(block(html, 1));
    expect(heads(table)).toEqual(["Customer", "Plan", "Health", "MRR"]);
    const trs = bodyRows(table);
    expect(trs).toHaveLength(5);
    trs.forEach((tr, i) => {
      const r = rows[i];
      const cells = text(tr);
      expect(cells.startsWith(r.customerName as string), `row ${i + 1} is ${r.customerName}`).toBe(true);
      const tier = (r.currentPlanTier as string).toLowerCase();
      expect(cells.toLowerCase()).toContain(tier);
      const mrr = r.mrrContributionCents as number;
      expect(cells.endsWith(mrr > 0 ? formatMoney(mrr, "usd") : "-")).toBe(true);
      const score = r.healthScore as number;
      const tone = { at_risk: "crit", watch: "warn", healthy: "ok" }[bandOf(score)];
      expect(tr).toMatch(new RegExp(`<span class="cap-pill"[^>]*data-tone="${tone}"[^>]*>[\\s\\S]*?${score}</span>`));
    });
    expect(text(table)).not.toMatch(/Personal outreach|Watch closely|Continue automated/);
  });
});

describe("the churn preview is the demo seed in the engine's three bands (J58)", async () => {
  const data = await load();
  const html = render(data);

  it("shows each band's customer count and MRR, high risk first", () => {
    const { intelligence } = demoSeed(asOf(data));
    const totals = { at_risk: [0, 0], watch: [0, 0], healthy: [0, 0] } as Record<string, [number, number]>;
    for (const c of intelligence.customerContext) {
      const t = totals[bandOf(c.healthScore as number)];
      t[0] += 1;
      t[1] += (c.mrrContributionCents as number) ?? 0;
    }
    expect(totals.at_risk[0], "the demo has high-risk customers").toBeGreaterThan(0);
    const third = text(block(html, 2));
    expect(third).toContain(
      `High risk ${totals.at_risk[0]} ${formatMoneyShort(totals.at_risk[1], "usd")}/mo at risk ` +
        `Medium ${totals.watch[0]} ${formatMoneyShort(totals.watch[1], "usd")}/mo ` +
        `Healthy ${totals.healthy[0]} ${formatMoneyShort(totals.healthy[1], "usd")}/mo`,
    );
  });
});

describe("the page is built from Capsomer's parts, teal, on the five sizes (J58)", async () => {
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
    }
  });

  it("draws health scores and bands as Capsomer badges, never a hand-rolled pill", () => {
    expect(html).toMatch(/<span class="cap-pill"[^>]*data-tone="crit"/);
    expect(html).toMatch(/<span class="cap-pill"[^>]*data-tone="ok"/);
    expect(html).not.toMatch(/rounded-full/);
  });

  it("puts the table in Capsomer's labelled, focusable scroll region", () => {
    const wraps = [...html.matchAll(/<div class="cap-table-wrap" role="region" aria-labelledby="([^"]+)" tabindex="0"><table class="cap-table"/g)];
    expect(wraps).toHaveLength(1);
    for (const w of wraps) expect(html).toContain(`id="${w[1]}"`);
  });

  it("carries no amber anywhere", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const FIVE = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
    const COLOUR =
      /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|green|success-text|error-text|caution|center|left|right)$/;
    const page = html.replace(/<figure[\s\S]*?<\/figure>/g, " ");
    expect(page).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of page.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (base.startsWith("text-") && !COLOUR.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE.has(s), `${s} is one of the five`).toBe(true);
  });

  it("draws its one chart with Enarratio, with a text equivalent", () => {
    const charts = [...html.matchAll(/data-enarratio="([a-z]+)"/g)].map((m) => m[1]);
    expect(charts).toEqual(["bar"]);
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="[^"]*MRR by plan[^"]*"/i);
    expect(html).toContain("<summary>Data table</summary>");
  });

  it("points every internal link at a route that exists", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/audit"), "the matcher finds a known route").toBe(true);
    const hrefs = [...html.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      const known =
        paths.has(h) ||
        [...paths].some((p) => p.includes(":") && new RegExp(`^${p.replace(/:[^/]+/g, "[^/]+")}$`).test(h));
      expect(known, `${h} is a route`).toBe(true);
    }
  });

  it("keeps the SpeakableSpecification pointing at classes the page carries", () => {
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const json = JSON.parse(ld) as { name: string; speakable: { cssSelector: string[] } };
    expect(json.name).toBe("Intelligence - Foxhound");
    expect(json.speakable.cssSelector.length).toBe(3);
    for (const sel of json.speakable.cssSelector) expect(html).toContain(sel.slice(1));
  });
});

function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}
