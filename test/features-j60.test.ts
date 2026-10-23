import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { FeatureFilter } from "~/components/feature-filter";
import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_SCHEDULE_WEEKLY,
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  MODEL_AUDIT_SUMMARY,
  MODEL_INTELLIGENCE_NARRATIVE,
  MODEL_RECOVERY_EMAIL,
  RECOVERY_TICK_CRON_NAME,
} from "~/lib/constants";
import { CRON_JOBS } from "~/lib/cron/registry";
import { DEMO_RESET_CRON_NAME } from "~/lib/demo/constants";
import { FEATURE_FILTER_CSS } from "~/lib/http/inline-styles";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import {
  FEATURE_FILTERS,
  FEATURE_PRODUCTS,
  cronEveryMinutes,
  cronWeekday,
  featureSections,
} from "~/lib/marketing/features-content";
import { MERCHANT_TOOL_NAMES } from "~/lib/mcp/tools.server";
import FeaturesPage, { meta as featuresMeta } from "~/routes/features";

import { RECOVA_FEATURES, RECOVA_SECTIONS } from "./fixtures/recova-features";

// J60 (job_85aa061b6020), row M10: /features. The spec is Recova's
// app/(marketing)/features/page.tsx (blob 04aa91d8), features-data.ts (blob
// a0a5dd20), FeatureCard.tsx (dd6c9a87), FeatureFilter.tsx (4e2ef1fa) and
// FeatureFilterShell.tsx (707d79df), all read whole.
//
// These read the RENDERED page, below the shared marketing page header (row
// M29, not this job's), so a class or a string that never reaches a reader
// cannot pass.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const repoFile = (path: string) => join(ROOT, path);

const FACTS = { cronJobCount: CRON_JOBS.length, merchantMcpToolCount: MERCHANT_TOOL_NAMES.length };

function render(): string {
  const props = { loaderData: { siteUrl: "https://example.com", facts: FACTS } } as never;
  const router = createMemoryRouter([{ path: "*", element: createElement(FeaturesPage, props) }], {
    initialEntries: ["/features"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The content column: Recova's 1100px container and everything inside it. */
function column(html: string): string {
  const at = html.indexOf("max-w-[1100px]");
  expect(at, "the 1100px column is on the page").toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<div", at));
}

/** Each <section> in page order, open tag to close. */
function sections(html: string): string[] {
  const out = [...column(html).matchAll(/<section [^>]*>[\s\S]*?<\/section>/g)].map((m) => m[0]);
  expect(out.length, "the page renders sections").toBeGreaterThan(0);
  return out;
}

/** Each feature card (the element carrying data-product), open tag through its body. */
function cards(html: string): { tag: string; body: string }[] {
  const out = [...column(html).matchAll(/<div ([^>]*data-product="[^"]+"[^>]*)>([\s\S]*?)<\/p><\/div>/g)].map((m) => ({
    tag: m[1],
    body: m[2],
  }));
  expect(out.length, "the page renders cards").toBeGreaterThan(0);
  return out;
}

function decode(s: string): string {
  return s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** The card's name: the first span in the card head. */
function cardName(body: string): string {
  const m = /<span[^>]*>([^<]+)<\/span>/.exec(body);
  return decode(m?.[1] ?? "");
}

function tokens(name: string): string {
  return name
    .replace("{tick}", String(cronEveryMinutes(CRON_SCHEDULE_RECOVERY_TICK)))
    .replace("{weekday}", cronWeekday(CRON_SCHEDULE_WEEKLY))
    .replace("{crons}", String(CRON_JOBS.length));
}

const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
// Every text-* class that sets a SIZE: the --text-* rem tokens app.css defines
// (the five and the older marketing roles) and Tailwind's stock scale. Read
// from the stylesheet, so a colour class is never mistaken for a size.
const SIZE_CLASSES = new Set([
  ...[...readFileSync(repoFile("app/app.css"), "utf8").matchAll(/--text-([a-z0-9-]+):\s*[\d.]+rem/g)].map((m) => `text-${m[1]}`),
  ...["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"].map((s) => `text-${s}`),
]);

describe("/features layout (J60, row M10)", () => {
  const html = render();

  it("renders Recova's eight sections in Recova's order, with Recova's ids and headings", () => {
    const got = sections(html).map((s) => ({
      id: /id="([^"]+)"/.exec(s)?.[1],
      title: textOf(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(s)?.[1] ?? ""),
    }));
    expect(got).toEqual(RECOVA_SECTIONS.map((s) => ({ id: s.id, title: s.label })));
  });

  it("gives every section its intro paragraph under the heading", () => {
    for (const s of sections(html)) {
      const head = /<h2[^>]*>[\s\S]*?<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(s);
      expect(head?.[1]?.length ?? 0, `intro under ${/id="([^"]+)"/.exec(s)?.[1]}`).toBeGreaterThan(20);
    }
  });

  it("links the sticky section nav to every section, in order", () => {
    const nav = /<nav aria-label="Sections"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    const links = [...nav.matchAll(/<a [^>]*href="#([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => ({ id: m[1], label: m[2] }));
    expect(links).toEqual(RECOVA_SECTIONS.map((s) => ({ id: s.id, label: s.label })));
  });

  it("keeps the header subtext's third sentence and the closing audit link", () => {
    expect(html).toContain(
      "Everything Foxhound does. Organized by capability, tagged by product. Built to stay current as the platform grows.",
    );
    const cta = /<a [^>]*href="\/audit"[^>]*>([^<]+)<\/a>/.exec(column(html));
    expect(cta?.[1]).toBe("Run your free audit");
  });

  it("states Foxhound's health bands from the engine in the intelligence example", () => {
    const intel = sections(html).find((s) => s.includes('id="intelligence"')) ?? "";
    expect(intel).toContain(
      `red below ${HEALTH_SCORE_AT_RISK_THRESHOLD}, orange ${HEALTH_SCORE_AT_RISK_THRESHOLD}-${WATCH_CEILING - 1}, green at or above ${WATCH_CEILING}.`,
    );
  });
});

describe("/features entries are Recova's, each a capability Foxhound ships", () => {
  const html = render();

  it("accounts for all 129 of Recova's entries, eight sections", () => {
    expect(RECOVA_FEATURES).toHaveLength(129);
    expect(new Set(RECOVA_FEATURES.map((f) => f.section))).toEqual(new Set(RECOVA_SECTIONS.map((s) => s.id)));
    for (const f of RECOVA_FEATURES) {
      if (f.foxhound === null) expect(f.why, `${f.name} is dropped with a reason`).toBeTruthy();
    }
  });

  it("renders, per section, exactly Recova's kept entries in Recova's order", () => {
    for (const s of sections(html)) {
      const id = /id="([^"]+)"/.exec(s)?.[1];
      const want = RECOVA_FEATURES.filter((f) => f.section === id && f.foxhound !== null).map((f) => tokens(f.foxhound!));
      const got = [...s.matchAll(/<div [^>]*data-product="[^"]+"[^>]*>([\s\S]*?)<\/p><\/div>/g)].map((m) => cardName(m[1]));
      expect(got, `section ${id}`).toEqual(want);
    }
  });

  it("renders none of the entries left out as unbuilt", () => {
    const names = new Set(cards(html).map((c) => cardName(c.body)));
    const dropped = RECOVA_FEATURES.filter((f) => f.foxhound === null).map((f) => f.name);
    expect(dropped.length, "the matcher has dropped names to look for").toBeGreaterThan(0);
    for (const name of dropped) {
      // Two names Recova uses twice survive in their other section ("Refresh token rotation" is dropped in both).
      if (RECOVA_FEATURES.some((f) => f.name === name && f.foxhound === name)) continue;
      expect(names.has(name), `${name} is not on the page`).toBe(false);
    }
  });

  // Where each rendered entry lives in Foxhound's code. A new entry with no row
  // here fails, and each file must exist and hold the named code.
  const EVIDENCE: Record<string, [string, string][]> = {
    "Recovery processing every {tick} minutes": [["app/lib/cron/registry.ts", "schedule: CRON_SCHEDULE_RECOVERY_TICK, handler: recoveryTick"]],
    "Win-back processing every {tick} minutes": [["app/lib/cron/registry.ts", '"winback-send", schedule: CRON_SCHEDULE_RECOVERY_TICK']],
    "Nightly expiring card alerts": [
      ["app/lib/cron/registry.ts", '"expiring-cards", schedule: CRON_SCHEDULE_DAILY'],
      ["app/lib/recovery/expiring-card-email.ts", "Foxhound's own /p/:token page"],
    ],
    "Nightly intelligence scoring": [["app/lib/cron/registry.ts", '"intelligence-ai", schedule: CRON_SCHEDULE_DAILY']],
    "Monthly MRR snapshots": [
      ["app/lib/cron/registry.ts", '"intelligence-sync", schedule: CRON_SCHEDULE_MONTHLY'],
      ["app/lib/intelligence/mrr.ts", "grossRevenueRetentionBps"],
    ],
    "Monthly recovery billing": [["app/lib/cron/registry.ts", '"billing-monthly", schedule: CRON_SCHEDULE_MONTHLY']],
    "Monthly audit auto-run": [
      ["app/lib/cron/registry.ts", '"monthly-audit", schedule: CRON_SCHEDULE_MONTHLY_AUDIT'],
      ["app/routes/app/settings/audit.tsx", 'Monthly audit digest</span>'],
    ],
    "{weekday} unified digest": [["app/lib/cron/registry.ts", '"weekly-digest", schedule: CRON_SCHEDULE_WEEKLY']],
    "Nightly demo reset": [["app/lib/cron/registry.ts", "schedule: CRON_SCHEDULE_DAILY, handler: demoReset"]],
    "Cron overlap prevention": [["workers/cron-lock.ts", "DurableObject"]],
    "Stale cron alerting": [["app/lib/cron/registry.ts", '"cron-health", schedule: CRON_SCHEDULE_DAILY']],
    "Decline classification": [["app/lib/recovery/decline.ts", "export"]],
    "Fraud decline detection": [["app/lib/recovery/schedule.ts", "Fraud never retries"]],
    "Customer health scoring": [["app/lib/intelligence/risk.ts", "export function computeHealthScore"]],
    "AI recovery email generation": [["app/lib/recovery/email-generation.ts", "export function findBrandVoiceViolations"]],
    "AI audit summary": [["app/lib/audit/summary.server.ts", "MODEL_AUDIT_SUMMARY"]],
    "AI nightly analyst": [["app/lib/intelligence/narrative.ts", "MODEL_INTELLIGENCE_NARRATIVE"]],
    "Cross-product dispute signal": [
      ["app/lib/intelligence/signals.ts", "export function buildDisputeSignals"],
      ["app/lib/intelligence/risk.ts", "scoreRefundsDisputes"],
    ],
    "Card Account Updater advisory": [["app/components/audit/sections.tsx", "Card Updater"]],
    "Renewal noise filtering": [["app/lib/constants.ts", 'FAILED_PAYMENT_STATUS_STRIPE_RETRYING = "stripe_retrying"']],
    "Per-category email sequences": [["app/lib/recovery/schedule.ts", "export const RECOVERY_SCHEDULES"]],
    "AI-written subject lines": [["app/lib/recovery/email-generation.ts", "Return a subject line and an HTML body."]],
    "Brand voice configuration": [
      ["app/routes/app/settings/brand-voice.tsx", "Same as main voice"],
      ["app/lib/recovery/email-generation.ts", "export function resolveBrandVoice"],
    ],
    "Merchant context": [["app/lib/recovery/email-generation.ts", "export function merchantContextLine"]],
    "Fallback templates": [["app/lib/engine/execute-step.ts", "buildTemplateEmail"]],
    "Open and click tracking": [
      ["app/routes.ts", '"./routes/utility/engagement-click.ts"'],
      ["app/lib/engagement/record.ts", "suspect"],
    ],
    "Email suppression": [["app/lib/email/dispatch.ts", "if (await isSuppressed(env, job.to))"]],
    "Send retry with backoff": [["app/lib/constants.ts", "export const SEND_RETRY_BACKOFF_MINUTES"]],
    "Win-back email sequences": [["app/lib/recovery/schedule.ts", "export const WIN_BACK_SCHEDULE"]],
    "Expiring card email": [["app/db/schema/recovery.ts", "expiring_card_alerts_card_month_uq"]],
    "Weekly unified digest": [["app/lib/recovery/digest-email.ts", "highRiskCustomers"]],
    "List-Unsubscribe headers": [["app/lib/email/send.ts", '"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"']],
    "Signed unsubscribe tokens": [["app/lib/email/unsubscribe-token.ts", "export async function verifyUnsubscribeToken"]],
    "Recovery dashboard": [["app/routes/app/recovery/index.tsx", "<RoiWidget"]],
    "Recovery rate chart": [["app/components/recovery-dashboard-charts.tsx", "function RecoveryRateChart"]],
    "Recovery timing chart": [["app/components/recovery-dashboard-charts.tsx", "recoveryTimingBuckets"]],
    "Email category chart": [["app/components/recovery-dashboard-charts.tsx", "Email performance by decline type"]],
    "Decline breakdown": [["app/components/recovery-dashboard-charts.tsx", "Decline breakdown"]],
    "Payment detail timeline": [["app/routes/app/recovery/payments/detail.tsx", "step.executedAt"]],
    "Email preview in timeline": [["app/routes/app/recovery/payments/detail.tsx", "sanitizeEmailPreviewHtml"]],
    "Sequence performance page": [["app/routes/app/recovery/sequences.tsx", '"Recovery rate": "var(--brand-ui)"']],
    "Disputes dashboard": [["app/routes/app/disputes/index.tsx", 'label="Win rate"']],
    "Dispute evidence staging": [["app/routes/app/disputes/detail.tsx", 'title="Staged evidence"']],
    "Intelligence dashboard": [["app/routes/app/intelligence/index.tsx", 'title="Monthly summary"']],
    "Customer health index": [["app/routes/app/intelligence/customers.tsx", "Sorted by health score, lowest first."]],
    "Customer detail page": [["app/routes/app/intelligence/customer.tsx", "drawHealthHistory(readings, w)"]],
    "Churn risk page": [["app/routes/app/intelligence/churn.tsx", "High-risk customers by MRR"]],
    "MRR movement waterfall": [["app/routes/app/intelligence/index.tsx", "<MovementCard"]],
    "Audit results page": [["app/components/audit/sections.tsx", "export function AuditSummary"]],
    "Audit history": [["app/routes.ts", '"./routes/app/audit/dashboard.tsx"']],
    "Platform status in Help": [["app/routes/app/help.tsx", "getVisibleCronStatus"]],
    "Admin webhook log": [["app/routes/admin/webhooks.tsx", "listWebhookEvents(db, filters)"]],
    "Admin audit log": [["app/lib/admin/audit-log.server.ts", "export async function listAuditLog"]],
    "Cron health table": [["app/routes/admin/crons.tsx", "listCronRows"]],
    "Stop recovery": [["app/lib/recovery/manual-actions.server.ts", 'if (intent === "cancel") return stopRecovery(req);']],
    "Run the next step now": [["app/lib/recovery/manual-actions.server.ts", "return triggerNextStep(req, pending.id, pending.stepType);"]],
    "Resend email step": [["app/lib/recovery/manual-actions.server.ts", "return resendLastEmail("]],
    "Manual payment recovery": [["app/lib/recovery/manual-actions.server.ts", 'if (intent === "mark_recovered")']],
    "Payment notes": [["app/routes/app/recovery/payments/detail.tsx", "Internal notes for this payment"]],
    "Submit dispute evidence": [["app/routes/app/disputes/detail.tsx", "Approve and submit (fee"]],
    "Audit lookback days": [["app/lib/settings/audit-settings.ts", "export const LOOKBACK_OPTIONS"]],
    "Audit auto-run toggle": [["app/routes/app/settings/audit.tsx", 'Monthly audit digest</span>']],
    "Processing pause": [["app/lib/recovery/manual-actions.server.ts", '"processing_paused"']],
    "Alert thresholds": [["app/routes/app/settings/alerts.tsx", "Create a new alert"]],
    "Email settings": [["app/routes/app/settings/email.tsx", 'name="senderName"']],
    "Brand voice": [["app/routes.ts", '"./routes/app/settings/brand-voice.tsx"']],
    "Theme toggle": [["app/routes/api/theme.ts", "await setAccountTheme(db, membership.accountId, theme);"]],
    "Team seats": [["app/routes/app/settings/team.tsx", "Invite a teammate"]],
    "Stripe Connect OAuth": [["app/routes.ts", '"./routes/auth/connect.tsx"']],
    "Multi-account support": [["app/components/nav/account-switcher.tsx", "export"]],
    "AES-256-GCM token encryption": [["app/lib/stripe/encryption.ts", "AES-256-GCM"]],
    "Stripe webhook processing": [["app/lib/webhooks/events.ts", 'case "charge.dispute.created"']],
    "Cloudflare Email Service delivery": [
      ["wrangler.jsonc", '"send_email"'],
      ["app/lib/queue/consumer.ts", "processEmailEvent"],
    ],
    "MCP Merchant connector": [["workers/app.ts", 'if (new URL(request.url).pathname === "/mcp")']],
    "MCP Admin connector": [["mcp/wrangler.jsonc", "admin-mcp.foxhoundapp.com"]],
    "OAuth 2.1 authorization server": [["mcp/src/door.ts", "@cloudflare/workers-oauth-provider"]],
    "API keys": [["app/lib/auth/mcp-tokens.ts", "SHA-256 hex of the presented token"]],
    "Anthropic API": [["app/lib/disputes/evidence.ts", "MODEL_RECOVERY_EMAIL"]],
    "Cloudflare D1": [["wrangler.jsonc", '"d1_databases"']],
    "Cloudflare Workers": [["workers/app.ts", "async queue(batch, env)"]],
    "Durable Object rate limiting": [["workers/rate-limiter.ts", "export class RateLimiterDurableObject"]],
    "Narrow Stripe scope": [["app/lib/constants.ts", "STRIPE_AUDIT_SCOPE"]],
    "Tenant isolation": [["app/lib/recovery/manual-actions.server.ts", "getFailedPaymentDetail(req.db, req.accountId"]],
    "AES-256-GCM encryption": [["app/lib/stripe/encryption.ts", "AES-GCM"]],
    "Stripe webhook verification": [["app/lib/stripe/webhook.ts", "constructEventAsync"]],
    "Scheduler-only crons": [["workers/app.ts", "for (const job of jobsForSchedule(controller.cron))"]],
    "PKCE S256 enforced": [["mcp/src/door.ts", "OAuthProvider"]],
    "Admin double-gate": [["mcp/src/door.ts", "on every"]],
    // Sign-in moved to site-runtime's Durable Object limiter in J52.
    "Rate limiting": [["app/lib/auth/rate-limit.server.ts", "export async function checkAuthLimit"]],
    "CAN-SPAM compliance": [["app/lib/email/send.ts", "email blocked: missing CAN-SPAM physical address"]],
    "WCAG 2.2 compliance": [["app/app.css", "prefers-contrast: more"]],
    "CVD accessibility": [["app/components/badge.tsx", "{children}"]],
    "Disposable email blocklist": [["app/lib/auth/options.ts", "isDisposableEmail"]],
    "Full database schema": [["app/db/schema/audit.ts", '"audit_runs"']],
    "{crons} cron jobs": [["app/lib/cron/registry.ts", "export const CRON_JOBS"]],
    "Network Intelligence Layer": [["app/lib/engine/outcomes.ts", "recordOutcome: the Network Intelligence Layer write"]],
    "Cross-product integration points": [
      ["app/lib/disputes/evidence.ts", "export function buildEvidenceFacts"],
      ["app/lib/intelligence/risk.ts", "recovery_engagement"],
    ],
    "Outcomes table": [["app/db/schema/platform.ts", '"outcomes"']],
    "Demo system": [["app/lib/demo/constants.ts", "export const DEMO_ACCOUNT_NAME"]],
    "AI cost tracking": [["app/lib/ai/cost.ts", "db.insert(aiCalls)"]],
  };

  it("names, for every entry on the page, the Foxhound code that does it", () => {
    const rendered = cards(html).map((c) => cardName(c.body));
    expect(rendered.length).toBeGreaterThan(50);
    const byName = new Map(Object.entries(EVIDENCE).map(([k, v]) => [tokens(k), v]));
    for (const name of rendered) {
      const rows = byName.get(name);
      expect(rows, `${name} has evidence`).toBeTruthy();
      for (const [file, needle] of rows ?? []) {
        expect(existsSync(repoFile(file)), `${file} exists (for ${name})`).toBe(true);
        expect(readFileSync(repoFile(file), "utf8"), `${file} holds ${needle} (for ${name})`).toContain(needle);
      }
    }
  });

  it("reads every cadence it states from the job's own schedule in the cron registry", () => {
    const schedule = (name: string) => CRON_JOBS.find((j) => j.name === name)?.schedule;
    expect(schedule(RECOVERY_TICK_CRON_NAME)).toBe(CRON_SCHEDULE_RECOVERY_TICK);
    expect(schedule("winback-send")).toBe(CRON_SCHEDULE_RECOVERY_TICK);
    expect(schedule("expiring-cards")).toBe(CRON_SCHEDULE_DAILY);
    expect(schedule("intelligence-ai")).toBe(CRON_SCHEDULE_DAILY);
    expect(schedule("intelligence-sync")).toBe(CRON_SCHEDULE_MONTHLY);
    expect(schedule("billing-monthly")).toBe(CRON_SCHEDULE_MONTHLY);
    expect(schedule("monthly-audit")).toBe(CRON_SCHEDULE_MONTHLY_AUDIT);
    expect(schedule("weekly-digest")).toBe(CRON_SCHEDULE_WEEKLY);
    expect(schedule(DEMO_RESET_CRON_NAME)).toBe(CRON_SCHEDULE_DAILY);
    expect(schedule("cron-health")).toBe(CRON_SCHEDULE_DAILY);
    expect(html).toContain(`Recovery processing every ${cronEveryMinutes(CRON_SCHEDULE_RECOVERY_TICK)} minutes`);
    expect(html).toContain(`${cronWeekday(CRON_SCHEDULE_WEEKLY)} unified digest`);
    expect(html).toContain(`${CRON_JOBS.length} cron jobs`);
    expect(html).toContain(`with ${MERCHANT_TOOL_NAMES.length} tools`);
  });

  it("names the Claude models the code actually calls", () => {
    expect(MODEL_RECOVERY_EMAIL).toMatch(/sonnet/);
    expect(MODEL_INTELLIGENCE_NARRATIVE).toMatch(/sonnet/);
    expect(MODEL_AUDIT_SUMMARY).toMatch(/haiku/);
  });

  it("moves its numbers when the facts move (no count is typed)", () => {
    const moved = featureSections({ cronJobCount: 99, merchantMcpToolCount: 77 }).flatMap((s) => s.features);
    expect(moved.some((f) => f.name === "99 cron jobs")).toBe(true);
    expect(moved.some((f) => f.description.includes("with 77 tools"))).toBe(true);
  });
});

describe("/features look: Capsomer's parts, teal, five sizes (Q11, Q12, RULES.md 5.2)", () => {
  const html = render();

  it("sits in Capsomer's teal family with Foxhound's neutrals", () => {
    expect(html).toMatch(/<div class="fh-cap[^"]*" data-cap-site="foxhound" data-family="teal"/);
  });

  it("builds each card from Capsomer's panel, body only, with no Foxhound class on the panel", () => {
    for (const c of cards(html)) {
      expect(c.tag).toMatch(/^class="cap-panel"/);
      expect(c.body).toMatch(/^<div class="cap-panel-body">/);
    }
  });

  it("draws each product tag as a Capsomer badge: outline for the three products, secondary for Audit and Platform", () => {
    for (const c of cards(html)) {
      const product = /data-product="([^"]+)"/.exec(c.tag)?.[1];
      const pill = /<span class="cap-pill" data-variant="([^"]+)">([^<]+)<\/span>/.exec(c.body);
      expect(pill?.[2]).toBe(product);
      expect(pill?.[1]).toBe(product === "Audit" || product === "Platform" ? "secondary" : "outline");
    }
  });

  it("makes the filter Capsomer's chips: Recova's six values in Recova's order, All pressed, the group named", () => {
    const group = /<div class="cap-chips" role="group" aria-label="Filter features by product">([\s\S]*?)<\/div>/.exec(html);
    expect(group, "the chip group").toBeTruthy();
    const chips = [...(group?.[1] ?? "").matchAll(/<button type="button" class="cap-chip" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)];
    expect(chips.map((m) => m[2])).toEqual([...FEATURE_FILTERS]);
    expect(chips.filter((m) => m[1] === "true").map((m) => m[2])).toEqual(["All"]);
    expect(html).not.toContain('role="tablist"');
  });

  it("makes the closing link Capsomer's primary button", () => {
    expect(html).toMatch(/<a class="cap-btn" data-variant="primary" data-size="lg" [^>]*href="\/audit"/);
    expect(html).not.toContain("btn-primary");
  });

  it("draws the sequence timeline's timing labels at full strength", () => {
    // At opacity-70 they measured 3.69:1 (light) and 3.64:1 (dark) on the
    // rendered page, under WCAG's 4.5:1 for their size.
    const intel = sections(html).find((s) => s.includes('id="automation"')) ?? "";
    expect(intel).toMatch(/<span class="font-mono text-micro">Day 1<\/span>/);
    expect(intel).not.toMatch(/opacity-\d/);
  });

  it("carries no amber anywhere on the page", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const body = column(html);
    expect(body).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of body.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (SIZE_CLASSES.has(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
  });
});

describe("/features focus rule (J60 review)", () => {
  it("hands chips and the button their own ring on /features only, never under forced colours", () => {
    const root = postcss.parse(readFileSync(repoFile("app/app.css"), "utf8"));
    const hits: { selector: string; media: string | null }[] = [];
    root.walkRules((r) => {
      let media: string | null = null;
      for (let p = r.parent; p && p.type !== "root"; p = p.parent) {
        if (p.type === "atrule" && (p as { name?: string }).name === "media") media = (p as { params: string }).params;
      }
      if (/\.cap-(chip|btn)\b/.test(r.selector) && r.selector.includes(":focus-visible")) hits.push({ selector: r.selector, media });
    });
    // The /pricing rule (.fh-cap .cap-btn, J54) also matches a button here; the
    // chips' ring is this page's own rule, scoped to .fh-features.
    expect(hits.filter((h) => h.selector.includes("cap-chip"))).toEqual([
      { selector: ".fh-features :is(.cap-chip, .cap-btn):focus-visible", media: "not (forced-colors: active)" },
    ]);
    expect(render()).toMatch(/<div class="fh-cap fh-features[^"]*" data-cap-site="foxhound" data-family="teal"/);
  });
});

describe("/features filter (Recova's mechanism, J60)", () => {
  it("renders with the wrapper set to All, so nothing is hidden before a press", () => {
    expect(render()).toContain('data-feature-filter="All"');
  });

  it("presses exactly the chosen chip and announces what is left", () => {
    const html = renderToStaticMarkup(
      createElement(FeatureFilter, { active: "Disputes", onChange: () => {}, shownCount: 4, totalCount: 102 }),
    );
    const pressed = [...html.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(pressed).toEqual(["Disputes"]);
    expect(html).toMatch(/role="status">Showing 4 of 102 features: Disputes</);
  });

  it("hides every card of another product for each product filter, through the hash-trusted CSS", () => {
    const rules = new Map<string, string>();
    postcss.parse(FEATURE_FILTER_CSS).walkRules((r) => {
      let display = "";
      r.walkDecls("display", (d) => {
        display = d.value;
      });
      rules.set(r.selector, display);
    });
    for (const p of FEATURE_PRODUCTS) {
      expect(rules.get(`[data-feature-filter="${p}"] [data-product]:not([data-product="${p}"])`), p).toBe("none");
    }
    const products = new Set(cards(render()).map((c) => /data-product="([^"]+)"/.exec(c.tag)?.[1]));
    for (const p of products) expect((FEATURE_PRODUCTS as readonly string[]).includes(p ?? "")).toBe(true);
  });
});

describe("/features meta", () => {
  const tags = featuresMeta({ loaderData: { siteUrl: "https://example.com", facts: FACTS } } as never) as {
    name?: string;
    content?: string;
  }[];
  const description = tags.find((t) => t.name === "description")?.content ?? "";

  it("carries Recova's description with no feature count", () => {
    expect(description).toBe(
      "Features across automation, intelligence, email, visibility, control, integration, and security. Built for Stripe subscription businesses.",
    );
    expect(description).not.toMatch(/\d/);
  });
});
