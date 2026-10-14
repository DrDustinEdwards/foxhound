import { Link } from "react-router";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatTimeAgo } from "~/lib/date-format";
import {
  getVisibleCronStatus,
  type CronDisplayStatus,
  type CronStatusRow,
} from "~/lib/help/platform-status.server";

import type { Route } from "./+types/help";

// /help, ported toward legacy app/(app)/help/page.tsx (row S23).
//
// Ruling 399 re-measured the 394 walk's claims against that REAL file, after
// 398 found the walk had compared against app/recovery/demo/help/page.tsx. Four
// of the walk's S23 items were false and are NOT actioned here: the H1 is
// "Help" on both sides, the container matches, there is no green reassurance
// banner on the real page, and there is no card-geometry divergence. What the
// walk could not see, because the demo twin does not render them, is what this
// commit builds: the Guides section, the Platform status section, the MCP
// connectors table, and the mailto contact block. Common questions goes from
// five differently-titled prose cards to legacy's six question-and-answer
// pairs.
//
// LEGACY'S SECTION ORDER IS KEPT: Common questions, Guides, Platform status,
// Contact. Legacy's raw type values are mapped onto Foxhound's app scale rather
// than ported literally, because 179/187 freeze the type scale in both
// directions; every other class string is legacy's (154).

export function meta() {
  return [{ title: "Help - Foxhound" }];
}

/**
 * Legacy's six QUICK_ANSWERS, checked one at a time against what Foxhound
 * actually does. Four are legacy's verbatim. TWO ARE REWRITTEN, both class (c)
 * truthfulness, and each names what made legacy's answer false here:
 *
 *   Q1 legacy: "The first email sends within an hour of the failure." False of
 *   Foxhound. Ruling 80 made recovery SILENT-RETRY-FIRST: a soft or network
 *   decline leads with a quiet retry before the customer is emailed at all
 *   (app/lib/recovery/schedule.ts RECOVERY_SCHEDULES). Telling a merchant an
 *   email goes out in the first hour would misdescribe the product's main
 *   selling point.
 *
 *   Q6 legacy: "On any pending email step in a payment timeline, you can also
 *   edit the body directly before it sends." False of Foxhound, and
 *   deliberately so: ruling 304 records Dustin declining to reproduce legacy's
 *   custom-body editor, whose own save path 404s in legacy (row S8). The brand
 *   voice half of the answer IS true and is kept, including per-category tone,
 *   which app/routes/app/settings/brand-voice.tsx renders.
 *
 * The other four were verified rather than assumed: the recovery-rate bands are
 * DESIGN.md's 0-20 red / 21-35 teal / 36+ green; the payments list really does
 * label a running sequence "Active" (app/lib/recovery/labels.ts); fraud
 * schedules really do carry no retry step; and the payment detail really does
 * render a sent step's subject and body with per-step open and click counts.
 */
export const QUICK_ANSWERS = [
  {
    q: "Why hasn't my payment recovered yet?",
    a: "Recovery sequences run over 30 days. For a soft or network decline Foxhound retries the card quietly first, before your customer is emailed at all, so a payment that would have gone through on its own never turns into a dunning email. An expired card or a suspected fraud block cannot be retried that way, so those lead with the email and its card-update link. Check the payment detail page to see exactly when the next step is scheduled.",
  },
  {
    q: "How do I know if a sequence is running?",
    a: "Go to Recovery, then Payments, and find the payment. If the status shows Active, the sequence is running. The payment detail page shows every step, scheduled, sent, and pending, with exact timestamps.",
  },
  {
    q: "What does the recovery rate percentage mean?",
    a: "Recovery rate is the percentage of failed payments that were successfully recovered during the selected period. Below 21% is low (shown in red), 21-35% is typical (teal), and above 36% is strong (green). Early accounts with few data points will see more variance.",
  },
  {
    q: "Why did a sequence stop before all steps ran?",
    a: "Sequences stop automatically when a payment recovers, remaining steps cancel immediately. They also stop if you use Stop recovery on the payment, if the subscription is cancelled, or if the decline is classified as fraud (fraud sequences have no retry steps).",
  },
  {
    q: "How do I see what email was sent to a customer?",
    a: "Go to Recovery, then Payments, click the payment, and open any completed email step in the timeline. The full subject line and email body are shown. Open and click counts are tracked per step.",
  },
  {
    q: "Can I change what the recovery emails say?",
    a: "Yes. Go to Settings, then Brand voice, to change the tone for all emails or per decline category. Foxhound writes each email in that voice when the step sends.",
  },
];

// Platform sits above the four product guides as a full-width card, the same
// hero layout the public docs index uses, so merchants see the same shape on
// both surfaces. Product order matches the docs index: Audit first because it
// is the lowest-friction surface.
//
// Slugs are Foxhound's own /docs routes; the descriptions are legacy's, which
// are terser than the docs index's own and are what legacy's help page renders.
// ONE IS CORRECTED: legacy says the audit has "four scopes" and Foxhound's
// engine has SIX (app/lib/audit/engine.ts). Class (c).
const PLATFORM_GUIDE = {
  href: "/docs/platform",
  title: "Platform",
  desc: "Connecting Stripe, settings, team management, and billing",
};

const PRODUCT_GUIDES = [
  { href: "/docs/audit", title: "Audit", desc: "Free Stripe diagnostic, six scopes" },
  {
    href: "/docs/recovery",
    title: "Recovery",
    desc: "Sequences, payments, dashboard, troubleshooting",
  },
  { href: "/docs/disputes", title: "Disputes", desc: "Evidence building, triage, submission" },
  {
    href: "/docs/intelligence",
    title: "Intelligence",
    desc: "Health scores, churn risk, MRR trends",
  },
];

/**
 * Foxhound's real MCP surface, which is ONE endpoint.
 *
 * Legacy lists two connectors, merchant and admin. Foxhound serves only the
 * merchant one: workers/app.ts matches the single pathname `/mcp` and no
 * `/mcp/admin` exists, so a second row would name an endpoint that is not
 * there. The tool count is ruling 383's measured 23 (15 reads, 8 writes).
 *
 * Legacy's note reads "For Claude.ai". Foxhound never names an AI vendor in
 * user-facing copy (capsid/conventions.md), so the note says what the endpoint
 * is for instead of who makes the client.
 */
const MCP_CONNECTORS = [
  {
    name: "Foxhound Merchant",
    url: "foxhoundapp.com/mcp",
    note: "23 tools, 15 read and 8 write",
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const nowMs = Date.now();
  // Cron status is platform-wide, not per-account, so no account scope filter.
  const crons = await getVisibleCronStatus(getDb(env), nowMs);
  return { crons, nowMs };
}

export default function Help({ loaderData }: Route.ComponentProps) {
  const { crons, nowMs } = loaderData;

  return (
    <main className="mx-auto max-w-[720px] px-5 py-10 sm:px-8">
      <header className="mb-8">
        <h1 className="m-0 mb-1 text-title font-medium text-text">Help</h1>
        <p className="m-0 text-label text-text-tertiary">
          Quick answers, guides, and platform status.
        </p>
      </header>

      {/* Section 1: Quick answers */}
      <section className="mb-12">
        <h2 className="mb-6 text-micro font-medium uppercase tracking-widest text-text-tertiary">
          Common questions
        </h2>
        <div className="space-y-6">
          {QUICK_ANSWERS.map((item) => (
            <div key={item.q}>
              <h3 className="mb-1 text-body font-medium text-text">{item.q}</h3>
              <p className="text-body leading-relaxed text-text-secondary">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Section 2: Docs by product */}
      <section className="mb-12">
        <h2 className="mb-6 text-micro font-medium uppercase tracking-widest text-text-tertiary">
          Guides
        </h2>
        <div className="flex flex-col gap-3">
          {/* Platform, full width on top. Same border and hover styling as the
              product cards below; the only difference is the layout slot. */}
          <Link
            to={PLATFORM_GUIDE.href}
            className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-brand"
          >
            <div className="mb-1 text-body font-medium text-text">{PLATFORM_GUIDE.title}</div>
            <div className="text-label text-text-secondary">{PLATFORM_GUIDE.desc}</div>
          </Link>

          {/* Four product guides, 2-col grid in Audit / Recovery / Disputes /
              Intelligence order. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PRODUCT_GUIDES.map((card) => (
              <Link
                key={card.href}
                to={card.href}
                className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-brand"
              >
                <div className="mb-1 text-body font-medium text-text">{card.title}</div>
                <div className="text-label text-text-secondary">{card.desc}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Section 3: Platform status */}
      <section className="mb-12">
        <h2 className="mb-6 text-micro font-medium uppercase tracking-widest text-text-tertiary">
          Platform status
        </h2>

        {/* Background jobs */}
        <div className="mb-4 overflow-hidden rounded-lg border border-border bg-surface">
          <div className="border-b border-border bg-surface2 px-4 py-3">
            <span className="text-label font-medium text-text-secondary">Background jobs</span>
          </div>
          <div className="divide-y divide-border">
            {crons.map((cron) => (
              <div key={cron.cronName} className="flex items-center justify-between px-4 py-3">
                <span className="text-label text-text">{cron.label}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-micro text-text-tertiary">
                    {formatTimeAgo(cron.lastSucceededAt, nowMs)}
                  </span>
                  <StatusDot status={cron.status} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* MCP connectors */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="border-b border-border bg-surface2 px-4 py-3">
            <span className="text-label font-medium text-text-secondary">MCP connectors</span>
          </div>
          <div className="divide-y divide-border">
            {MCP_CONNECTORS.map((c) => (
              <div key={c.url} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-label text-text">{c.name}</div>
                  <div className="truncate font-mono text-micro text-text-tertiary">{c.url}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-micro text-text-tertiary">{c.note}</span>
                  <div className="h-2 w-2 shrink-0 rounded-full bg-green" aria-hidden="true" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 4: Contact */}
      <section>
        <h2 className="mb-6 text-micro font-medium uppercase tracking-widest text-text-tertiary">
          Contact
        </h2>
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="mb-1 text-body font-medium text-text">
            <a
              href="mailto:support@foxhoundapp.com"
              className="text-text transition-colors hover:text-brand-text"
            >
              support@foxhoundapp.com
            </a>
          </div>
          <div className="text-label text-text-secondary">
            Email for billing questions, account issues, or anything not covered in the guides.
            Responses within 24 hours on business days.
          </div>
        </div>
      </section>
    </main>
  );
}

function StatusDot({ status }: { status: CronDisplayStatus }) {
  // Pending falls back to the muted text token so it reads as a sentinel rather
  // than as a status, which is legacy's own reasoning for the same four colors.
  const colorClass: Record<CronDisplayStatus, string> = {
    ok: "bg-green",
    stale: "bg-brand",
    error: "bg-red",
    pending: "bg-text-tertiary",
  };
  return (
    <div className={`h-2 w-2 shrink-0 rounded-full ${colorClass[status]}`} aria-label={status} />
  );
}

export type { CronStatusRow };
