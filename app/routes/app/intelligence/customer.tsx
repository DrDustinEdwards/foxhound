import { useCallback, useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { Breadcrumb } from "capsomer/react/breadcrumb";
import { Panel } from "capsomer/react/panel";
import "capsomer/breadcrumb.css";
import "capsomer/panel.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /intelligence/customers does.
import "~/site-header.css";

import { EnarratioFigure } from "~/components/enarratio-figure";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatDateShort } from "~/lib/date-format";
import { planTierPill, scheduledChangeLabel } from "~/lib/intelligence/customer-directory";
import {
  disputeSignalFields,
  drawHealthHistory,
  engagementSignalFields,
  recoverySignalFields,
  tenureFromSince,
  type HealthReading,
  type SignalField,
} from "~/lib/intelligence/customer-detail";
import { healthScoreClassName } from "~/lib/intelligence/health-band";
import {
  getCustomerActivity,
  getCustomerHealthDetail,
} from "~/lib/intelligence/views.server";
import { formatMoney } from "~/lib/money-format";
import { recommendOneCustomer } from "~/lib/intelligence/recommendations.server";
import { RecommendationBanner } from "~/components/recommendation-banner";

import type { Route } from "./+types/customer";

// /intelligence/customers/:id (row S18, job J68). Recova is the spec: its real
// page, app/(app)/intelligence/customers/[id]/page.tsx at blob 8d31766d, with
// HealthSparkline (f4a163f5), RawDataToggle (640505cd), IntegrityLayerBanner
// (1614dfaf) and lib/intelligence/customer-context-ssr.ts (a499c285), each
// read whole. In Recova's order and 1080px width: the breadcrumb, the back
// link and the recovery payments link, the header card, the three signal
// cards, the health score with its chart, the AI assessment when there is
// one, and the footer.
//
// Built from Capsomer 0.9.0's parts (Q10), the chart by Enarratio (Q1), amber
// throughout. No Foxhound class sits on a Capsomer element. Recova's
// 12px card radius, its uppercase mono labels, the score beside the "Health
// score" heading and its plan colors wait for Capsomer's per-site layer
// (capsomer job_ec5ec0754626), listed in the J68 pull request.
//
// Foxhound's engine, never Recova's: the signal cards are counted from
// Foxhound's own tables (getCustomerActivity), the score and its color are
// Foxhound's bands, and LTV, which nothing in Foxhound computes, says so
// (RULES.md 2.1). The IntegrityLayerBanner is Recova's
// rules worked out when the page loads (recommendOneCustomer), as Recova's
// score-ssr did. The admin-only raw data toggle is not built (Foxhound's admin
// is behind Cloudflare Access, Q6, and the toggle printed raw database values,
// RULES.md 1.5).
//
// The factors list and the predictions table are Foxhound's own and HELD for
// Dustin, as the dashboard's at-risk table is (J67): kept exactly as they
// were, after Recova's sections. The docs guide's Recommendations section
// names the factors list (docs-content.ts).

export function meta() {
  return [{ title: "Customer health - Foxhound" }];
}

// Account-scoped by construction: getCustomerHealthDetail's query carries
// BOTH accountId and the requested stripeCustomerId in one predicate, so a
// customer belonging to another account resolves to null (404), never a
// cross-tenant read (the account-scoping audit flagged this route by name).
// getCustomerActivity carries the same pair on every query.
export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const nowMs = Date.now();
  const [detail, activity] = await Promise.all([
    getCustomerHealthDetail(db, accountId, params.id),
    getCustomerActivity(db, accountId, params.id, nowMs),
  ]);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return {
    nowMs,
    accountName: auth.membership.accountName,
    // Only what the page shows reaches the browser.
    customer: {
      stripeCustomerId: detail.stripeCustomerId,
      customerName: detail.customerName,
      customerEmail: detail.customerEmail,
      currentPlanName: detail.currentPlanName,
      currentPlanTier: detail.currentPlanTier,
      mrrContributionCents: detail.mrrContributionCents,
      currency: detail.currency,
      ltvCents: detail.ltvCents,
      scheduled: scheduledChangeLabel(detail.scheduledChangeKind, detail.scheduledChangeAt, new Date(nowMs)),
      customerSince: detail.customerSince,
      healthScore: detail.healthScore,
      healthFactors: detail.healthFactors,
      aiAssessment: detail.aiAssessment,
      aiAssessmentGeneratedAt: detail.aiAssessmentGeneratedAt,
      history: detail.history.map((h) => ({ recordedAt: h.recordedAt, healthScore: h.healthScore })),
      predictions: detail.predictions,
    },
    activity,
    // Recova's IntegrityLayerBanner reads the customer's recommendation. A
    // read failure leaves the banner out rather than failing the page.
    prediction: await recommendOneCustomer(db, accountId, detail.stripeCustomerId, nowMs).catch(() => null),
  };
}

type Loaded = Route.ComponentProps["loaderData"];

export default function CustomerHealthPage({ loaderData }: Route.ComponentProps) {
  const { customer, activity, accountName, nowMs, prediction } = loaderData;
  const recoveryCount = activity.recovery.failedPaymentCount;
  const hasDisputeHistory = activity.disputes.count > 0;

  // Recova's main: max-w-[1080px] mx-auto px-4 md:px-8 py-8. The shell owns
  // the page's one <main> (ruling 146), so this is a plain wrapper.
  return (
    <div className="mx-auto max-w-[1080px] px-4 py-8 md:px-8">
      <div className="mb-4">
        <Breadcrumb
          items={[
            { label: "Customers", href: "/intelligence/customers" },
            { label: customer.customerName ?? customer.stripeCustomerId },
          ]}
          renderLink={({ href, className, children }) => (
            <Link to={href} className={className}>
              {children}
            </Link>
          )}
        />
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-4 text-label">
        {/* Recova computes `account.name ?? 'Customers'`, so an account with no
            name read "All Customers customers"; with no name this reads "All
            customers". */}
        <Link
          to="/intelligence/customers"
          className="inline-flex min-h-6 items-center font-mono text-accent-text no-underline hover:text-accent-hover"
        >
          <span aria-hidden="true">←&nbsp;</span>
          {accountName ? `All ${accountName} customers` : "All customers"}
        </Link>
        {recoveryCount > 0 ? (
          <Link
            to="/recovery/payments"
            className="group inline-flex min-h-6 items-center gap-1 text-accent-text no-underline hover:text-accent-hover"
          >
            {recoveryCount} recovery {recoveryCount === 1 ? "payment" : "payments"}
            <ArrowRight
              aria-hidden="true"
              size={13}
              strokeWidth={1.5}
              className="transition-transform duration-150 group-hover:translate-x-0.5"
            />
          </Link>
        ) : null}
      </div>

      <div className="flex flex-col gap-5">
        <HeaderCard customer={customer} lastSeenAt={activity.lastActivityAt} nowMs={nowMs} />

        {/* Recova's IntegrityLayerBanner, customers/[id]/page.tsx 133. */}
        <RecommendationBanner prediction={prediction} surface="customer" nowMs={nowMs} className="" />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SignalCard
            title="Recovery signals"
            fields={recoverySignalFields(activity.recovery)}
            empty="No recovery events"
          />
          <SignalCard
            title="Dispute signals"
            fields={disputeSignalFields(activity.disputes)}
            empty="No dispute history"
          />
          <SignalCard
            title="Engagement signals"
            fields={engagementSignalFields(activity.engagement)}
            empty="No engagement data yet"
          />
        </div>

        <HealthScoreCard score={customer.healthScore} history={customer.history} />

        {/* Recova leaves this card out entirely when there is no assessment.
            Foxhound's analyst writes one for the at-risk customers it names
            in the month's narrative (ai-run.server.ts writeNarrativeReport),
            so the heading is true of every customer that has one. */}
        {customer.aiAssessment ? (
          <Panel title="Why this customer needs attention">
            <p className="m-0 text-body leading-relaxed text-text">{customer.aiAssessment}</p>
            {customer.aiAssessmentGeneratedAt ? (
              <p className="m-0 mt-3 font-mono text-micro text-text-subtle">
                Updated {formatDateShort(customer.aiAssessmentGeneratedAt)}
              </p>
            ) : null}
          </Panel>
        ) : null}
      </div>

      {recoveryCount > 0 || hasDisputeHistory ? (
        <p className="mt-5 mb-2 text-center text-micro text-text-subtle">
          This customer&apos;s data is shared across Recovery, Disputes, and Intelligence.
          {recoveryCount > 0 ? (
            <>
              {" "}
              View their recovery history in{" "}
              <Link to="/recovery/payments" className="text-accent-text no-underline hover:text-accent-hover">
                Recovery
              </Link>
              .
            </>
          ) : null}
          {hasDisputeHistory ? (
            <>
              {" "}
              View their disputes in{" "}
              <Link to="/disputes/dashboard" className="text-accent-text no-underline hover:text-accent-hover">
                Disputes
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : null}

      <HeldSections customer={customer} />
    </div>
  );
}

/** Recova's header card: the name as the page's h1, email and Stripe id
 *  beneath, the plan pill and MRR on the right, then Tenure, LTV, Last seen
 *  and Customer since, two across on a phone and four from md. A body-only
 *  Capsomer panel, since Recova's card has no title of its own. */
function HeaderCard({
  customer,
  lastSeenAt,
  nowMs,
}: {
  customer: Loaded["customer"];
  lastSeenAt: Date | null;
  nowMs: number;
}) {
  const pill = planTierPill(customer.currentPlanTier);
  const stats: SignalField[] = [
    { label: "Tenure", value: tenureFromSince(customer.customerSince, nowMs) },
    {
      label: "LTV",
      // Nothing in Foxhound computes lifetime value (signals.ts), so this says
      // so rather than showing a dash that reads as zero (RULES.md 2.1).
      value: customer.ltvCents != null ? formatMoney(customer.ltvCents, customer.currency) : "Not computed",
    },
    {
      label: "Last seen",
      // The latest event Foxhound has for this customer (getCustomerActivity),
      // never customer_context.last_seen_at, which the nightly sync sets to its
      // own run time. With no event, Foxhound has not seen them, and says so.
      value: lastSeenAt ? formatDateShort(lastSeenAt) : "Not tracked",
    },
    { label: "Customer since", value: customer.customerSince ? formatDateShort(customer.customerSince) : "-" },
  ];
  return (
    <div className="cap-panel">
      <div className="cap-panel-body">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="m-0 text-title font-semibold text-text">{customer.customerName ?? "(no name)"}</h1>
            <p className="m-0 mt-1 break-all font-mono text-label text-text-subtle">
              {customer.customerEmail ?? "-"} · <span className="text-text-tertiary">{customer.stripeCustomerId}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Capsomer's pill markup rather than its Pill component, which
                adds a status glyph to any toned pill; a plan is not a status
                (the customers page's choice, J30). Recova shows the plan's name
                and falls back to the tier's word. */}
            <span className="cap-pill" data-tone={pill.tone} data-variant="outline">
              {customer.currentPlanName ?? pill.label}
            </span>
            <span className="font-mono text-body text-text">
              {/* Recova: any value, zero included, as "$X/mo"; "-" only when
                  there is none. */}
              {customer.mrrContributionCents != null
                ? `${formatMoney(customer.mrrContributionCents, customer.currency)}/mo`
                : "-"}
            </span>
          </div>
        </div>
        {/* A planned change or cancellation from the customer's Stripe
            subscription schedule or cancel_at, beside what they pay now. */}
        {customer.scheduled ? (
          <p className="m-0 mt-3 text-right text-label text-text-secondary">{customer.scheduled}</p>
        ) : null}
        <dl className="m-0 mt-5 grid grid-cols-2 gap-4 border-t border-border-sub pt-4 md:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="text-micro uppercase tracking-wide text-text-tertiary">{s.label}</dt>
              <dd className="m-0 mt-1 font-mono text-label text-text">{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** One of Recova's three signal cards: its title, then each field's label and
 *  value on a line, or Recova's empty sentence. */
function SignalCard({ title, fields, empty }: { title: string; fields: SignalField[] | null; empty: string }) {
  return (
    <Panel title={title} size="sm">
      {fields === null ? (
        <p className="m-0 text-label italic text-text-subtle">{empty}</p>
      ) : (
        <dl className="m-0 flex flex-col gap-2 text-label">
          {fields.map((f) => (
            <div key={f.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-text-secondary">{f.label}</dt>
              <dd className="m-0 text-right font-mono text-text">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}

/** Recova's health score card: the score out of 100 in its band's color and,
 *  with two readings or more, the chart of the last 30, oldest first. */
function HealthScoreCard({ score, history }: { score: number | null; history: HealthReading[] }) {
  const readings = useMemo(() => [...history].reverse(), [history]);
  const draw = useCallback((w: number) => drawHealthHistory(readings, w), [readings]);
  return (
    <Panel title="Health score">
      <p className="m-0 flex items-baseline justify-end gap-3">
        <span
          className={`font-mono text-display font-semibold leading-none ${
            score === null ? "text-text-tertiary" : healthScoreClassName(score)
          }`}
        >
          {score ?? "-"}
        </span>
        <span className="text-label text-text-subtle">/ 100</span>
      </p>
      {readings.length >= 2 ? <EnarratioFigure draw={draw} /> : null}
    </Panel>
  );
}

/** Foxhound's own factors list and predictions table, HELD for Dustin and kept
 *  exactly as they were before J68 (see the note at the top of this file). */
function HeldSections({ customer }: { customer: Loaded["customer"] }) {
  const factors = customer.healthFactors;
  return (
    <>
      <section className="mt-8">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Factors</p>
        {factors.length === 0 ? (
          <p className="mt-2 text-body text-text-tertiary">
            No factors moved this score away from the baseline.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {factors.map((f) => (
              <li
                key={f.signal}
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface p-3"
              >
                <span className="text-label text-text">{f.detail}</span>
                <span
                  className={`font-mono text-label ${f.deltaPoints < 0 ? "text-error-text" : "text-success-text"}`}
                >
                  {f.deltaPoints > 0 ? "+" : ""}
                  {f.deltaPoints}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {customer.predictions.length > 0 ? (
        <section className="mt-8">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Predictions</p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-3 font-normal">Predicted</th>
                  <th className="px-4 py-3 font-normal">Score</th>
                  <th className="px-4 py-3 font-normal">Horizon</th>
                  <th className="px-4 py-3 font-normal">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {customer.predictions.map((p, i) => (
                  <tr key={i} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3 text-text-tertiary">{p.predictedAt.toLocaleDateString()}</td>
                    <td className="px-4 py-3 font-mono text-text">{p.score}</td>
                    <td className="px-4 py-3 text-text-tertiary">{p.horizonDays}d</td>
                    <td className="px-4 py-3 text-text-tertiary">{p.realizedOutcome ?? "pending"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
