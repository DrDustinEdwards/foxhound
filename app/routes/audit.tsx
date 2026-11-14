import { marketingMeta } from "~/lib/seo/meta";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { mountTurnstile, verifyTurnstile } from "@dustinedwards/site-runtime/turnstile";
import { useEffect, useId, useRef } from "react";
import { data, Form, useNavigation } from "react-router";
import { ButtonLink } from "capsomer/react/link";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/select.css";
import "capsomer/status.css";
// The site header's CSS (app/site-header.css), so the page is whole under any layout. Capsomer's
// tokens and the amber family come with the root route (app/error-page.css).
import "~/site-header.css";

import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { AUDIT_LOOKBACK_DAYS } from "~/lib/constants";
import { AUDIT_ACCESS_CHIP, AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import {
  estimateLeakage,
  recordEstimatorRun,
  type EstimatorResult,
} from "~/lib/estimator/estimate.server";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/audit";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import "~/audit-tool.css";

// Real no-auth estimator + audit marketing page (Phase 6 Pass 3). Ported the
// legacy app/audit/page.tsx marketing structure (Capsid read_repo_file,
// namespace recova, repo legacy), replacing the earlier Pass-1 RouteStub.
// Corrections vs legacy, matching this repo's established audit copy
// discipline (products/audit.tsx): no fabricated recovery-rate stat, and no
// bare "2 to 3% of MRR fails every month" marketing figure. The estimator's
// rate is the seeded benchmark_data median (drizzle/seed/benchmark_data.sql),
// a rounded interpolation and not a study, so the result card names it as an
// assumption applied to the visitor's MRR. It never claims to describe other
// accounts, and the seed's percentile spread is not shown.
//
// J18, the visual walk: Recova's app/audit/page.tsx (blob 054edf70)
// and app/audit/layout.tsx (blob 0544e53b), read whole, stay the spec for the
// content, order and width. The look is Capsomer's: the
// pill is its badge, every card its panel, the form its field, select and
// button, the unavailable notice its alert, each call to action its primary
// button. Amber throughout, text at Recova's sizes: the hero h1 clamp, the
// tinted mono pill and the covers card's 40px padding are set through the
// parts' own variables.

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Free Stripe Revenue Leakage Audit",
      description:
        "Estimate in 30 seconds what your Stripe account loses to failed payments, with no signup or credit card. Connect Stripe afterward to see your real numbers.",
      path: "/audit",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
  ];
}

type ActionResult =
  | { ok: true; result: EstimatorResult; mrrCents: number; currency: string }
  | { ok: false; error: string };

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return {
    siteUrl: siteUrl(env),
    // Both vars are required for a working form: TURNSTILE_SECRET_KEY gates
    // the action's server-side verify call, TURNSTILE_SITE_KEY is what the
    // client widget actually renders with. Gating on the secret alone
    // (Phase 6 review finding) could report "available" while the widget
    // had no sitekey to produce a token, landing on a stuck challenge
    // instead of the intended clean "temporarily unavailable" state.
    turnstileAvailable: Boolean(env.TURNSTILE_SECRET_KEY) && Boolean(env.TURNSTILE_SITE_KEY),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? "",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);

  // Hard requirement: while TURNSTILE_SECRET_KEY is unset, the estimator
  // never accepts a submission, silently or otherwise, no matter what a
  // direct POST to this action carries. This check runs before anything
  // else, including reading the form body.
  if (!env.TURNSTILE_SECRET_KEY) {
    return data<ActionResult>(
      { ok: false, error: "The estimator is temporarily unavailable. Please check back soon." },
      { status: 503 },
    );
  }

  const form = await readForm(request, BODY_MAX_BYTES);
  const mrrDollars = Number(form.get("mrr"));
  const customerCount = Number(form.get("customerCount"));
  const currency = String(form.get("currency") ?? "usd").toLowerCase();
  const turnstileToken = String(form.get("cf-turnstile-response") ?? "");

  if (!Number.isFinite(mrrDollars) || mrrDollars <= 0) {
    return data<ActionResult>(
      { ok: false, error: "Enter a monthly recurring revenue amount greater than 0." },
      { status: 400 },
    );
  }
  if (!Number.isFinite(customerCount) || customerCount <= 0) {
    return data<ActionResult>(
      { ok: false, error: "Enter a customer count greater than 0." },
      { status: 400 },
    );
  }
  if (!turnstileToken) {
    return data<ActionResult>(
      { ok: false, error: "Please complete the verification challenge." },
      { status: 400 },
    );
  }

  // site-runtime's verifyTurnstile fails closed and never throws: an
  // unreachable siteverify is a refusal here, not a 500.
  const verification = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, {
    remoteIp: request.headers.get("CF-Connecting-IP"),
  });
  if (!verification.ok) {
    return data<ActionResult>(
      { ok: false, error: "Verification failed. Please try again." },
      { status: 400 },
    );
  }

  const mrrCents = Math.round(mrrDollars * 100);
  const db = getDb(env);
  const result = await estimateLeakage(db, { mrrCents, customerCount, currency });
  if (!result) {
    return data<ActionResult>(
      {
        ok: false,
        error: "The estimator cannot estimate this amount yet. Try a different MRR amount.",
      },
      { status: 200 },
    );
  }

  await recordEstimatorRun(db, { mrrCents, customerCount, currency, result, nowMs: Date.now() });

  return data<ActionResult>({ ok: true, result, mrrCents, currency });
}

// The four lines of Recova's covers card.
//
// One clause of Recova's own copy is NOT restored, because it names a render
// Foxhound does not have: its dispute "historical win rate" is a platform
// figure, NOT PORTED at 365 binding 31. The "estimated recoverable amount" is
// back with the results page's Recoverable estimate (Dustin, 2026-10-29). The expiring-cards line
// says what the engine's predicate actually does, which includes
// already-expired cards; Recova says "next 30 days" and counts them too.
//
// FOUR LINES, NOT SIX, and that is Recova's editorial call matched rather than
// an omission. Both engines compute six scopes; Recova's card lists four and
// folds past-due subscriptions and the Card Updater advisory into the run
// itself. Both render on the results page.
const COVERS: ReadonlyArray<readonly [string, string]> = [
  [
    "Failed invoices",
    `Payments Stripe marked uncollectible in the last ${AUDIT_LOOKBACK_DAYS} days, the decline reason behind each one, and the estimated recoverable amount.`,
  ],
  [
    "Expiring cards",
    "Customers whose card has expired or expires within the next month, and the MRR at risk before those payments fail.",
  ],
  [
    "Open disputes",
    "Unmanaged chargebacks, your won and lost record, and revenue accepted without evidence submission.",
  ],
  ["Business health", "MRR, ARR, active subscriptions, voluntary versus involuntary churn rate."],
];

export default function AuditPage({ loaderData, actionData }: Route.ComponentProps) {
  const { turnstileAvailable, turnstileSiteKey } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    // Recova's column: 680px, centered, px-4 md:px-8, py-10 md:py-20. In
    // Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as /demos
    // and /pricing), comfortable density so each panel takes Capsomer's roomier
    // padding.
    <div
      className="fh-audit-wrap fh-cap fh-center"
      data-cap-site="foxhound"
      data-family="amber"
      data-density="comfortable"
    >
      {/* Bespoke hero, restored per ruling 64: Recova's /audit sits OUTSIDE
          (marketing) and never used MarketingPageHeader. The pill is
          Capsomer's badge in Recova's treatment: mono at 0.75rem with 0.06em
          tracking, amber words on a 13% amber tint inside a 27% amber edge. */}
      <div className="fh-audit-block">
        <span className="fh-audit-label cap-pill fh-mono fh-caption fh-regular">
          FREE LOST REVENUE AUDIT
        </span>
      </div>

      {/* Recova's clamp(28px,5vw,44px) h1, in rem. The words are Recova's,
          drift fixed on sight: they describe the audit, not the
          estimator, so they hold in every state of the form below. */}
      <h1 className="fh-audit-title fh-semibold fh-text">
        See everything leaking from your Stripe account
      </h1>

      <p className="fh-audit-text fh-product-sub fh-faint">
        Enter your MRR and customer count for a directional estimate. No signup, no credit card, 30
        seconds.
      </p>

      {/* The estimator: Foxhound's own working surface, which Recova has no
          counterpart for. */}
      <div className="fh-audit-grid">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="cap-stack fh-left" data-gap="5">
              <h2 className="fh-mono fh-tiny fh-regular fh-quiet fh-caps">
                Free leakage estimator
              </h2>

              {/* A standing notice, not a failure the visitor caused: an info
                  banner (role="status"), never a critical alert. */}
              {!turnstileAvailable ? (
                <Banner tone="info">
                  The estimator is temporarily unavailable while verification is being configured.
                  Please check back soon, or run the full audit by connecting Stripe directly.
                </Banner>
              ) : (
                <>
                  {actionData && !actionData.ok ? <Alert>{actionData.error}</Alert> : null}

                  {actionData?.ok ? (
                    <EstimatorResultCard
                      result={actionData.result}
                      currency={actionData.currency}
                    />
                  ) : (
                    <EstimatorForm busy={busy} siteKey={turnstileSiteKey} attempt={actionData} />
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Recova's covers card: its heading, the four dot lines, "See my
          numbers" full width, and the note under it. Recova's note said
          "Read-only Stripe access" while asking for read_write. Stripe gives
          read_only only to Extensions (2026-10-29), so the audit asks for
          read_write too, and the note says what is true: Foxhound only reads
          and disconnects itself when the window ends (audit-access.ts). */}
      <div className="fh-audit-grid-2">
        {/* Recova's covers card: p-6, p-10 from md, 16px corners. */}
        <section className="fh-audit-band cap-panel">
          <div className="cap-panel-body">
            <div>
              <h2 className="fh-audit-title-2 fh-caption fh-medium fh-quiet">
                What the audit covers
              </h2>
              <ul className="fh-audit-list">
                {COVERS.map(([title, desc]) => (
                  <li key={title} className="fh-audit-item fh-left">
                    <span className="fh-audit-label-2" aria-hidden="true" />
                    <span>
                      <span className="fh-audit-label-3 fh-line fh-copy fh-medium fh-text">
                        {title}
                      </span>
                      <span className="fh-line fh-small fh-faint">{desc}</span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* Recova's full-width button: py-4 at 1rem bold, 10px corners. */}
              <ButtonLink
                to="/audit/connect"
                className="fh-audit-link fh-bold"
                variant="primary"
                size="lg"
                block
              >
                See my numbers
              </ButtonLink>
              <p className="fh-audit-text-2 fh-small fh-faint">
                {AUDIT_ACCESS_CHIP}. 30 seconds. No account required.
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Recova's two figure cards, restored as treatment. The
          figures are product facts read from Foxhound's constants, not Recova's
          "2 to 3%" industry benchmark, which Recova's own comment calls
          marketing copy and which no source supports.
          Plain panels, not Capsomer's stat tile: a tile is always a link, and
          these lead nowhere. */}
      <div className="fh-audit-grid-4">
        <div className="cap-panel">
          <div className="cap-panel-body">
            <div>
              <p className="fh-audit-text-3 fh-mono fh-display fh-bold fh-green">
                {AUDIT_LOOKBACK_DAYS} days
              </p>
              <p className="fh-caption fh-faint">of failed invoices the audit reads</p>
            </div>
          </div>
        </div>
        <div className="cap-panel">
          <div className="cap-panel-body">
            <div>
              <p className="fh-audit-text-4 fh-mono fh-display fh-bold">$0</p>
              <p className="fh-caption fh-faint">cost to run this estimate today</p>
            </div>
          </div>
        </div>
      </div>

      <p className="fh-audit-text-5 fh-small fh-faint">Want to see the app before connecting?</p>
      {/* A 24px target (min-h-6) for a link that stands alone. */}
      <a href="/demos/recovery" rel="nofollow" className="fh-audit-link-2 fh-copy fh-accent">
        View live demo &rarr;
      </a>

      <div className="fh-audit-grid-5">
        <div className="cap-panel">
          <div className="cap-panel-body">
            {/* SESSION 71, PHASE (f): the CTA is the audit, which needs no
                account and is the top of PRICING rev 3's funnel; signup is
                what the RESULTS page offers afterwards, which is where Recova
                puts it too. */}
            <div>
              <p className="fh-audit-text-6 fh-body fh-medium fh-text">
                Want your real numbers instead of an estimate?
              </p>
              <p className="fh-audit-text-7 fh-small fh-relaxed fh-soft">
                Connect Stripe and Foxhound runs the full audit on the spot: what failed and why,
                what is expiring, where your disputes stand, and your recurring revenue. No account
                needed. Foxhound only reads, writes nothing back to Stripe, and disconnects itself
                after {AUDIT_GRANT_MINUTES} minutes.
              </p>
              <ButtonLink to="/audit/connect" variant="primary">
                Run the free audit
              </ButtonLink>
              <p className="fh-audit-text-8 fh-mono fh-tiny fh-faint">
                No account required &middot; The audit only reads &middot; Nothing is stored
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The estimator's form: Capsomer's field, select and primary button. The
 *  Turnstile widget is site-runtime's, drawn again after each answer from the
 *  action because a token is good for one verify. */
function EstimatorForm({
  busy,
  siteKey,
  attempt,
}: {
  busy: boolean;
  siteKey: string;
  attempt: unknown;
}) {
  const currencyId = useId();
  const widget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !widget.current) return;
    return mountTurnstile(widget.current, siteKey);
  }, [siteKey, attempt]);
  return (
    <Form method="post" className="cap-stack" data-gap="5">
      <Field label="Monthly recurring revenue (MRR)">
        <input className="cap-input" name="mrr" type="number" autoComplete="off" required />
      </Field>
      <Field label="Active customer count">
        <input
          className="cap-input"
          name="customerCount"
          type="number"
          autoComplete="off"
          required
        />
      </Field>
      <div className="cap-field">
        <label className="cap-field-label" htmlFor={currencyId}>
          Currency
        </label>
        <div className="cap-select-wrap">
          <select className="cap-select" id={currencyId} name="currency" defaultValue="usd">
            <option value="usd">USD</option>
            <option value="eur">EUR</option>
            <option value="gbp">GBP</option>
            <option value="cad">CAD</option>
            <option value="aud">AUD</option>
          </select>
        </div>
      </div>

      <div ref={widget} />

      <Button type="submit" variant="primary" pending={busy} block>
        Estimate my leakage
      </Button>
    </Form>
  );
}

/** The assumed monthly failure rate, a fraction of MRR, as "2.2%". */
function formatRatePercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(1))}%`;
}

function EstimatorResultCard({ result, currency }: { result: EstimatorResult; currency: string }) {
  return (
    <div>
      <p className="fh-audit-text-3 fh-mono fh-tiny fh-faint">Estimated monthly leakage</p>
      <p className="fh-audit-text-9 fh-mono fh-display fh-semibold fh-text">
        {formatMoney(result.estimatedLeakageCents, currency)}
      </p>
      <p className="fh-audit-text-5 fh-small fh-relaxed fh-soft">
        An estimate from your inputs, not a measurement: your MRR times an assumed{" "}
        {formatRatePercent(result.medianPct)} of MRR failing each month at your revenue. The rate is
        an assumption, not data about your account or anyone else's. Connect Stripe for your
        account's actual numbers.
      </p>
      {/* The estimator's own next step: the audit reads the merchant's actual
          account, takes no account to run, and is what this card has been
          promising as "your real numbers" all along. */}
      <ButtonLink to="/audit/connect" variant="primary">
        Run the free audit on your real numbers
      </ButtonLink>
    </div>
  );
}

export const headers = () => publicPageHeaders();
