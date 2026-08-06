import { Badge } from "~/components/badge";
import { GroupedBars } from "~/components/charts";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { DECLINE_CATEGORIES, type DeclineCategory } from "~/lib/constants";
import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { listExecutedRecoverySteps } from "~/lib/recovery/queries.server";
import { buildCategorySections, summarizeStepPerformance, type StepCard } from "~/lib/recovery/sequence-performance";

import type { Route } from "./+types/sequences";

export function meta() {
  return [{ title: "Sequences - Foxhound" }];
}

// Per-category framing, matching Foxhound's REAL schedules (schedule.ts), not
// legacy's 4-category hardcoded set: soft/network lead with a silent retry
// (PRICING.md's silent-first rebuild), expired/fraud/unknown are email-only
// because a retry can never clear them, and revoked is a single hold email,
// never a dunning cadence.
const CATEGORY_DESCRIPTIONS: Record<DeclineCategory, string> = {
  soft: "Insufficient funds and generic declines. Foxhound retries silently first, then follows up by email if the retry does not clear.",
  network: "Processing errors and issuer timeouts. Foxhound retries quickly, then follows up by email if retries keep failing.",
  expired: "Expired card declines. A retry never succeeds against an expired card, so every step is an email carrying the card update link.",
  fraud: "Fraud flags and security holds. Foxhound never retries a fraud decline. Every step is a gentle reassurance email.",
  revoked: "The customer explicitly revoked payment authorization. One email offers a clean choice, cancel or add a new payment method, then the sequence ends.",
  unknown: "An unrecognized decline code. Foxhound fails closed: no silent retry, email only, the same cadence as an expired card.",
};

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const rawSteps = await listExecutedRecoverySteps(db, accountId);
  // Sanitize once, here, server-side - the pure aggregation module never
  // touches raw AI HTML (see email-preview.server.ts).
  const steps = rawSteps.map((s) => ({
    ...s,
    aiBodyHtml: s.aiBodyHtml ? sanitizeEmailPreviewHtml(s.aiBodyHtml) : null,
  }));

  const performance = summarizeStepPerformance(steps);
  const sections = buildCategorySections(DECLINE_CATEGORIES, steps);

  return { performance, sections };
}

function StepPerformanceChart({ chart }: { chart: ReturnType<typeof summarizeStepPerformance>["chart"] }) {
  if (chart.length === 0) {
    return <p className="text-label text-text-tertiary">No step performance to show yet.</p>;
  }
  return (
    <GroupedBars
      labels={chart.map((c) => c.label)}
      series={[
        { name: "Open rate", colorClassName: "text-green", values: chart.map((c) => c.openRatePct) },
        { name: "Click rate", colorClassName: "text-blue", values: chart.map((c) => c.clickRatePct) },
        { name: "Recovery rate", colorClassName: "text-amber", values: chart.map((c) => c.recoveryRatePct) },
      ]}
    />
  );
}

function StepCardView({ card }: { card: StepCard }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="text-label font-medium text-text">{card.label}</h3>
            {card.timingLabel ? (
              <span className="rounded bg-border px-2 py-0.5 font-mono text-micro text-text-tertiary">
                {card.timingLabel}
              </span>
            ) : null}
          </div>
          {card.kind === "retry" ? (
            <p className="mt-1 text-micro text-text-subtle">Automatic retry. No email sent.</p>
          ) : card.sent > 0 && card.latestSubject ? (
            <p className="mt-1 truncate text-micro text-text-subtle">
              <span>Latest subject: </span>
              {card.latestSubject}
            </p>
          ) : null}
        </div>

        {card.kind === "retry" ? (
          card.attempted > 0 ? (
            <div className="shrink-0 text-right">
              <p className="font-mono text-body font-medium text-text">{card.successRatePct}%</p>
              <p className="text-micro text-text-subtle">
                {card.recovered} of {card.attempted} recovered
              </p>
            </div>
          ) : (
            <p className="shrink-0 text-micro text-text-subtle">No data yet</p>
          )
        ) : card.sent > 0 ? (
          <div className="flex shrink-0 gap-5">
            <div className="text-right">
              <p className="font-mono text-label font-medium text-text">{card.sent}</p>
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">sent</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-label font-medium text-text">{card.openRatePct}%</p>
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">opened</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-label font-medium text-text">{card.clickRatePct}%</p>
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">clicked</p>
            </div>
          </div>
        ) : (
          <p className="shrink-0 text-micro text-text-subtle">No data yet</p>
        )}
      </div>

      {card.kind === "email" && card.sent > 0 && card.latestBodyHtml ? (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-micro text-text-subtle hover:text-text">
            <span className="inline-block transition-transform group-open:rotate-90">{"▸"}</span>
            Preview latest email
          </summary>
          {/* latestBodyHtml is sanitized server-side in the loader before it
              ever reaches this component (email-preview.server.ts). */}
          <div
            className="mt-3 overflow-x-auto rounded-lg border border-border bg-bg px-4 py-3 text-label leading-relaxed text-text-subtle"
            dangerouslySetInnerHTML={{ __html: card.latestBodyHtml }}
          />
        </details>
      ) : null}
    </div>
  );
}

export default function RecoverySequences({ loaderData }: Route.ComponentProps) {
  const { performance, sections } = loaderData;

  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8 py-10">
      {/* Ruling 147 f1-f3, legacy app/(app)/recovery/sequence/page.tsx:
      max-w-[1280px] mx-auto px-4 md:px-8 py-10. Flat py-10, like payments. */}
      <h1 className="text-title font-medium text-text">Sequences</h1>
      <p className="mt-2 text-label text-text-tertiary">Live performance data from your recovery emails</p>

      {performance.totalSent === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No emails sent yet. Recovery sequences start automatically when a payment fails.
        </p>
      ) : (
        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Emails sent" value={String(performance.totalSent)} />
          <StatCard label="Avg open rate" value={`${performance.avgOpenRatePct}%`} />
          <StatCard label="Avg click rate" value={`${performance.avgClickRatePct}%`} />
          <StatCard
            label="Best step"
            value={performance.bestStep ? performance.bestStep.label : "-"}
            subtext={performance.bestStep ? `${performance.bestStep.clickRatePct}% click rate` : "min 3 sends"}
          />
        </section>
      )}

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Step performance</p>
        <p className="mt-1 text-micro text-text-subtle">
          Recovery includes customers who updated payment after reading the email, even without clicking the tracked
          link.
        </p>
        <div className="mt-3 text-text-tertiary">
          <StepPerformanceChart chart={performance.chart} />
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-8">
        {sections.map(({ category, stepCards }) => (
          <section key={category}>
            <Badge tone="neutral">{DECLINE_CATEGORY_LABELS[category]}</Badge>
            <p className="mt-2 text-label text-text-tertiary">{CATEGORY_DESCRIPTIONS[category]}</p>
            <div className="mt-3 flex flex-col gap-3">
              {stepCards.map((card) => (
                <StepCardView key={card.stepType} card={card} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
