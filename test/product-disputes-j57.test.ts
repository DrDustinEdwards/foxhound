import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { disputeFeeCents } from "~/lib/billing/fees";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS, type DisputeState } from "~/lib/constants";
import { DEMO_ACCOUNT_ID, DEMO_MEMBER_EMAIL } from "~/lib/demo/constants";
import { buildDisputesSeed } from "~/lib/demo/disputes-seed";
import { DISPUTE_STATE_LABELS, deadlineUrgency, humanizeDisputeReason } from "~/lib/disputes/labels";
import { formatDateMonthDay } from "~/lib/date-format";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";
import routes from "~/routes";
import DisputesProductPage, { loader } from "~/routes/products/disputes";

// J57 (job_827e854076e9), the Disputes spoke. Recova's spec, read whole at
// HEAD: app/(marketing)/product/disputes/page.tsx (blob c412d54f),
// components/product/ProductSections.tsx (ba3aed7c), ProductFAQ.tsx
// (7c08a5a2), DisputesDashboardPreview.tsx (dcde195e) with the
// DisputesDashboardView it renders (3c1b7a98), and
// components/docs/DisputesTablePreview.tsx (ed33fa95) with DisputeStatusPill
// (8eb22d08) and TriagePill (1485726d).
//
// These read the RENDERED page, fed by the route's own loader, so a value that
// never reaches a reader cannot pass. Every expected number is worked out here
// a second way, straight from the demo seed and the engine constants, never
// read back from the modules under test.

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
    request: new Request("https://foxhoundapp.com/products/disputes"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
}

function render(loaderData: LoaderData): string {
  const Page = DisputesProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/products/disputes"],
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
const PCT = `${DISPUTE_FEE_BPS / 100}%`;
const CAP = formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd");
const RESOLVED = new Set<string>(["resolved_won", "resolved_lost"]);

/** The deadline bands, read off the engine's own function, not retyped. */
function band(name: "urgent" | "soon"): number {
  let last = -1;
  for (let d = 1; d <= 60; d++) if (deadlineUrgency(d) === name) last = d;
  return last;
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

/** The demo seed's disputes in the order the merchant dashboard lists them:
 *  newest first, as Recova orders the list (listDisputes, read by
 *  app/routes/app/disputes/index.tsx). */
function seedInDashboardOrder(now: Date) {
  const seed = buildDisputesSeed(DEMO_ACCOUNT_ID, now, DEMO_MEMBER_EMAIL);
  const withEvidence = new Set(
    seed.disputeEvidence.filter((e) => (e.fieldValue as string).trim() !== "").map((e) => e.disputeId as string),
  );
  const rows = seed.disputes.map((d) => ({
    ...d,
    state: d.state as string,
    createdAt: d.createdAt as Date,
    resolvedAt: (d.resolvedAt as Date | null) ?? null,
    evidenceDeadline: (d.evidenceDeadline as Date | null) ?? null,
    submittedAt: (d.submittedAt as Date | null) ?? null,
    submittedBy: (d.submittedBy as string | null) ?? null,
    hasEvidence: withEvidence.has(d.id as string),
  }));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The status word the dashboard shows, worked out from Recova's rules
 *  (DisputesDashboardView.tsx, blob 3c1b7a98, deriveRecovaStatus) as Dustin
 *  approved them on PR #75: Won, Lost, We submitted or Submitted externally,
 *  Evidence ready once the draft holds evidence, else Foxhound's own label. */
function expectedStatus(r: ReturnType<typeof seedInDashboardOrder>[number]): string {
  if (r.state === "resolved_won") return "Won";
  if (r.state === "resolved_lost") return "Lost";
  if (r.state === "submitted") return r.submittedBy === "merchant_or_stripe" ? "Submitted externally" : "We submitted";
  if ((r.state === "pending_review" || r.state === "approved") && r.hasEvidence) return "Evidence ready";
  return DISPUTE_STATE_LABELS[r.state as DisputeState];
}

function tableAfter(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at, `${marker} is on the page`).toBeGreaterThan(-1);
  const start = html.indexOf("<table", at);
  expect(start, `a table follows ${marker}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</table>", start));
}

function heads(table: string): string[] {
  return [...table.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
}

function bodyRows(table: string): string[] {
  const tbody = table.slice(table.indexOf("<tbody"));
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
}

describe("/products/disputes follows Recova's sections, in Recova's order (J57)", async () => {
  const html = render(await load());
  const body = text(html);

  it("renders the hero, How it works, the three feature blocks, Pricing, Questions and the closing block in order", () => {
    const marks = [
      "Evidence built automatically.",
      "How it works",
      "Dispute opens on Stripe",
      "Submit or accept",
      "What you see after connecting",
      "Every dispute. Status. Deadline. Fee.",
      "The numbers",
      "Built automatically before you open it.",
      "Pricing",
      "Questions",
      "Stop losing disputes to missed deadlines.",
    ];
    let at = -1;
    for (const m of marks) {
      const next = body.indexOf(m, at + 1);
      expect(next, `"${m}" comes after the mark before it`).toBeGreaterThan(at);
      at = next;
    }
  });

  it("draws Recova's three blocks as tall, lifted, tall", () => {
    const kinds = [...html.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["tall", "lifted", "tall"]);
    // The section label and the first eyebrow are the same words in Recova.
    expect(body.split("What you see after connecting").length - 1).toBe(2);
  });

  it("keeps Recova's headline with the fee read from the engine", () => {
    expect(html).toMatch(new RegExp(`<h1[^>]*>Evidence built automatically\\.\\n${escape(PCT)} only when you win\\.</h1>`));
    expect(body).toContain(`${PCT} of won disputes, capped at ${CAP} · Nothing on losses or accepted disputes · Invoiced monthly`);
  });

  it("names no Recova", () => {
    expect(html).not.toMatch(/recova/i);
  });

  it("puts every call to action on Connect Stripe, and the guide on /docs/disputes", () => {
    const ctas = [...html.matchAll(/<a [^>]*>Connect Stripe<\/a>/g)].map((m) => m[0]);
    expect(ctas).toHaveLength(3);
    for (const a of ctas) expect(a).toContain('href="/connect"');
    expect(html).toMatch(/<a [^>]*href="\/docs\/disputes"[^>]*>Read the guide/);
  });
});

describe("the copy says only what Foxhound does (J57)", async () => {
  const html = render(await load());
  const body = text(html);

  it("never claims an auto-submit (RULES.md 5.6): every submission waits for an approval", () => {
    expect(body).not.toMatch(/auto-submit (fires|24 hours)/i);
    expect(body).not.toMatch(/before the deadline if enabled/i);
    expect(body).not.toMatch(/submits it to Stripe before the deadline/i);
    expect(body).toContain("then submits it to Stripe once someone on your team approves it.");
    expect(body).toContain("No auto-submit: nothing reaches Stripe until you approve it");
  });

  it("does not claim the triage score, the evidence sources or the reminders Foxhound has no producer for", () => {
    expect(body).not.toMatch(/0-100 triage score/);
    expect(body).not.toMatch(/Five evidence sources/i);
    expect(body).not.toMatch(/Deadline reminder emails/i);
    expect(html).not.toMatch(/href="https:\/\/stripe\.com\/radar"/);
    expect(body).toContain("A triage score with a fight or accept recommendation is not built yet.");
  });

  it("names only the evidence evidence.ts drafts: no transaction data, no cancellation evidence", () => {
    expect(body).toContain("Foxhound builds evidence from your recovery history, then submits it to Stripe");
    expect(body).not.toMatch(/transaction data/i);
    expect(body).not.toMatch(/cancellation evidence/i);
    expect(body).toContain("Subscription_canceled disputes depend on the recovery email history.");
  });

  it("states the cap on the fee wherever the price is stated", () => {
    expect(body).toContain(`of disputes Foxhound wins, capped at ${CAP} per dispute`);
  });

  it("does not call the /connect scope read-only (RULES.md 2.2)", () => {
    expect(body).not.toMatch(/read-only stripe access/i);
    expect(body).toContain(`Read and write Stripe access · ${PCT} only when you win`);
  });

  it("names the deadline bands the engine colours", () => {
    expect(body).toContain(
      `Deadlines inside ${band("soon")} days appear in the warning color. Inside ${band("urgent")} days, red.`,
    );
  });

  it("asks Recova's three questions", () => {
    const items = [...html.matchAll(/<details class="cap-disclosure" name="([^"]+)"[^>]*><summary>([^<]+)<\/summary>/g)];
    expect(items.map((m) => m[2].replace(/&#x27;/g, "'"))).toEqual([
      "Does Foxhound handle all dispute types?",
      "What if I want to submit evidence myself?",
      "What does Foxhound charge if a dispute is accepted?",
    ]);
    expect(new Set(items.map((m) => m[1])).size).toBe(1);
  });
});

describe("the dashboard preview is the demo seed through Foxhound's own math (J57)", async () => {
  const data = await load();
  const html = render(data);
  const demo = lazy(() => {
    const now = asOf(data);
    return { now, rows: seedInDashboardOrder(now) };
  });

  it("shows the dashboard's five cards with the demo's figures, twice (block 1 and block 2)", () => {
    const { rows } = demo();
    const open = rows.filter((r) => !RESOLVED.has(r.state));
    const atStake = open.reduce((s, r) => s + (r.amountCents as number), 0);
    const submitted = rows.filter((r) => r.submittedAt !== null && r.submittedBy !== "merchant_or_stripe").length;
    const won = rows.filter((r) => r.state === "resolved_won").length;
    const lost = rows.filter((r) => r.state === "resolved_lost").length;
    const feesCharged = rows
      .filter((r) => r.state === "resolved_won" && r.submittedAt !== null)
      .reduce((s, r) => s + ((r.resolvedFeeCents as number | null) ?? disputeFeeCents(r.amountCents as number, DISPUTE_FEE_CAP_CENTS)), 0);
    expect(open.length, "the demo has open disputes").toBeGreaterThan(0);
    expect(won + lost, "the demo has resolved disputes").toBeGreaterThan(0);
    // The demo has won fees, but the dashboard's Fees owed counts only fees
    // still owed: the demo's one invoice is paid and a demo account is never
    // billable, so the demo dashboard reads $0.00 (PR #79), and so must this.
    expect(feesCharged, "the demo has fees, all of them paid").toBeGreaterThan(0);

    const winRate = `${Math.round((won / (won + lost)) * 100)}%`;
    const cards = `Open disputes ${open.length} At stake ${formatMoney(atStake, "usd")} Submitted by Foxhound ${submitted} Fees owed ${formatMoney(0, "usd")} Win rate ${winRate} ${won} won of ${won + lost} resolved`;
    expect(text(html).split(cards).length - 1, "both blocks carry the five cards").toBe(2);
    expect(text(html)).not.toContain("Saved vs Smart Disputes");
  });

  it("never shows Recova's saving figure or Stripe's unsourced 30%", () => {
    expect(text(html)).not.toMatch(/30%/);
    expect(text(html)).not.toMatch(/\$84\.80|\$64\.70/);
  });

  it("lists every demo dispute in the dashboard's order, with the dashboard's columns and no Mode or Fee", () => {
    const { now, rows } = demo();
    const table = tableAfter(html, 'data-block="tall"');
    // The merchant dashboard's columns (app/routes/app/disputes/index.tsx).
    // Mode is out for good (Dustin, 2026-10-15,
    // cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6) and the Fee column
    // is not built there, so neither header appears here.
    expect(heads(table)).not.toContain("Mode");
    expect(heads(table)).not.toContain("Fee");
    expect(heads(table)).toEqual(["Customer", "Amount", "Reason", "Foxhound status", "Deadline"]);
    // Nor does the block's text describe the Mode column it no longer draws.
    expect(text(html)).not.toContain("active fee relationship");
    const trs = bodyRows(table);
    expect(trs).toHaveLength(rows.length);
    trs.forEach((tr, i) => {
      const r = rows[i];
      const cells = text(tr);
      expect(cells.startsWith(r.customerName as string), `row ${i + 1} is ${r.customerName}`).toBe(true);
      expect(cells).toContain(r.customerEmail as string);
      expect(cells).toContain(formatMoney(r.amountCents as number, "usd"));
      expect(cells).toContain(humanizeDisputeReason(r.reason as string));
      expect(cells).toContain(expectedStatus(r));
      // No Fee cell: the dashboard has none, and "fee owed" would be untrue
      // beside a Fees owed card that reads $0.00 (the demo's fees are paid).
      expect(cells).not.toMatch(/fee owed|No charge/);
      expect(cells).not.toMatch(/\bActive\b/);
      if (!RESOLVED.has(r.state)) {
        const days = Math.ceil(((r.evidenceDeadline as Date).getTime() - now.getTime()) / DAY_MS);
        expect(cells).toMatch(new RegExp(`\\b${days}d$`));
      }
    });
  });

  it("links nowhere a person cannot follow: no per-row View link to Recova's missing /audit/:id", () => {
    const table = tableAfter(html, 'data-block="tall"');
    expect(table).not.toMatch(/<a /);
    expect(html).not.toMatch(/href="\/audit\/d/);
  });
});

describe("the dispute table preview is the demo seed, with no triage Foxhound does not compute (J57)", async () => {
  const data = await load();
  const html = render(data);
  const blocks = html.split('data-block="tall"');

  it("shows Recova's six rows in the dashboard's order, with the engine's state words and deadlines", () => {
    const rows = seedInDashboardOrder(asOf(data)).slice(0, 6);
    expect(blocks.length, "two tall blocks").toBe(3);
    const table = tableAfter(blocks[2], "<table");
    expect(heads(table)).toEqual(["Customer", "Amount", "Reason", "Status", "Deadline"]);
    const trs = bodyRows(table);
    expect(trs).toHaveLength(6);
    trs.forEach((tr, i) => {
      const r = rows[i];
      const cells = text(tr);
      expect(cells.startsWith(r.customerName as string), `row ${i + 1} is ${r.customerName}`).toBe(true);
      expect(cells).toContain(formatMoney(r.amountCents as number, "usd"));
      // A raw Stripe code is a database value shown to a person (RULES.md 1.5).
      expect(cells).toContain(humanizeDisputeReason(r.reason as string));
      expect(cells).not.toContain(r.reason as string);
      expect(cells).toContain(expectedStatus(r));
      expect(cells.endsWith(formatDateMonthDay(r.evidenceDeadline))).toBe(true);
    });
  });

  it("draws no triage pill or confidence, because nothing outside the demo seed writes one", () => {
    expect(blocks.length, "two tall blocks").toBe(3);
    const table = text(tableAfter(blocks[2], "<table"));
    expect(table).not.toMatch(/\bFight\b|\bAccept\b|\bTriage\b/);
    expect(table).not.toMatch(/\d+%/);
  });
});

describe("the page is built from Capsomer's parts, teal, on the five sizes (J57)", async () => {
  const html = render(await load());

  it("sits in Capsomer's teal family with Foxhound's neutrals", () => {
    expect(html).toMatch(/^<div class="fh-cap[^"]*" data-family="teal"/);
  });

  it("draws every call to action as Capsomer's primary button", () => {
    const ctas = [...html.matchAll(/<a [^>]*>Connect Stripe<\/a>/g)].map((m) => m[0]);
    expect(ctas).toHaveLength(3);
    for (const a of ctas) {
      expect(a).toMatch(/class="cap-btn"/);
      expect(a).toContain('data-variant="primary"');
    }
  });

  it("draws the status words as Capsomer badges, never a hand-rolled pill", () => {
    expect(html).toMatch(/<span class="cap-pill"[^>]*data-tone="ok"[^>]*>[\s\S]*?Won<\/span>/);
    expect(html).toMatch(/<span class="cap-pill"[^>]*data-tone="crit"[^>]*>[\s\S]*?Lost<\/span>/);
    expect(html).not.toMatch(/rounded-full/);
  });

  it("puts both tables in Capsomer's labelled, focusable scroll region", () => {
    const wraps = [...html.matchAll(/<div class="cap-table-wrap" role="region" aria-labelledby="([^"]+)" tabindex="0"><table class="cap-table"/g)];
    expect(wraps).toHaveLength(2);
    for (const w of wraps) expect(html).toContain(`id="${w[1]}"`);
  });

  it("lets a keyboard reach each tall block's own scroll area", () => {
    const talls = html.split('data-block="tall"').slice(1);
    expect(talls, "both tall blocks are drawn").toHaveLength(2);
    for (const tall of talls) {
      expect(tall).toMatch(/^[^>]*>[\s\S]*?<div [^>]*role="region"[^>]*tabindex="0"[^>]*class="[^"]*overflow-y-auto/);
    }
  });

  it("carries no amber anywhere", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const FIVE = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
    const COLOUR =
      /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|green|success-text|error-text|caution|center|left|right)$/;
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

  it("draws no chart, because Recova draws none on this page", () => {
    expect(html).not.toMatch(/<svg[^>]*role="img"/);
    expect(html).not.toMatch(/enarratio/i);
  });

  it("points every internal link at a route that exists", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/connect"), "the matcher finds a known route").toBe(true);
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
