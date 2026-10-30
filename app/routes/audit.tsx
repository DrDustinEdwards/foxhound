import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { mountTurnstile } from "@dustinedwards/site-runtime/turnstile";
import { useEffect, useId, useRef } from "react";
import { data, Form, Link, useNavigation } from "react-router";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
import "capsomer/select.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the
// badge, the field, the select, the alert, the button and the focus ring read.
// The site header loads the same file; importing it here keeps the page whole
// under any layout.
import "~/site-header.css";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { AUDIT_LOOKBACK_DAYS } from "~/lib/constants";
import { AUDIT_ACCESS_CHIP, AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import { estimateLeakage, recordEstimatorRun, type EstimatorResult } from "~/lib/estimator/estimate.server";
import { formatMoney } from "~/lib/money-format";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";
import { verifyTurnstileToken } from "~/lib/turnstile/verify.server";

import type { Route } from "./+types/audit";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

// Real no-auth estimator + audit marketing page (Phase 6 Pass 3). Ported the
// legacy app/audit/page.tsx marketing structure (Capsid read_repo_file,
// namespace recova, repo legacy), replacing the earlier Pass-1 RouteStub.
// Corrections vs legacy, matching this repo's established audit copy
// discipline (products/audit.tsx): no fabricated recovery-rate stat, and the
// old bare "2 to 3% of MRR fails every month" marketing figure is replaced
// with our own seeded, source-cited benchmark_data range rather than an
// unsourced number.
//
// J18 (row M22), the visual walk: Recova's app/audit/page.tsx (blob 054edf70)
// and app/audit/layout.tsx (blob 0544e53b), read whole, stay the spec for the
// content, order and width. The look is Capsomer's (RULES.md 1.1, Q12): the
// pill is its badge, every card its panel, the form its field, select and
// button, the unavailable notice its alert, each call to action its primary
// button. Amber throughout, text at Recova's sizes: the hero h1 clamp, the
// tinted mono pill and the covers card's 40px padding are set through the
// parts' own variables.

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Free Stripe Revenue Leakage Audit - Foxhound",
      description:
        "Estimate in 30 seconds what your Stripe account loses to failed payments, with no signup or credit card. Connect Stripe afterward to see your real numbers.",
      path: "/audit",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
    ...(loaderData
      ? [
          jsonLd(breadcrumbListJsonLd(loaderData.siteUrl, [
            { name: "Home", path: "/" },
            { name: "Audit", path: "/audit" },
          ])),
        ]
      : []),
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

  const form = await request.formData();
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
    return data<ActionResult>({ ok: false, error: "Enter a customer count greater than 0." }, { status: 400 });
  }
  if (!turnstileToken) {
    return data<ActionResult>({ ok: false, error: "Please complete the verification challenge." }, { status: 400 });
  }

  const verification = await verifyTurnstileToken(
    env,
    turnstileToken,
    request.headers.get("CF-Connecting-IP") ?? undefined,
  );
  if (!verification.success) {
    return data<ActionResult>({ ok: false, error: "Verification failed. Please try again." }, { status: 400 });
  }

  const mrrCents = Math.round(mrrDollars * 100);
  const db = getDb(env);
  const result = await estimateLeakage(db, { mrrCents, customerCount, currency });
  if (!result) {
    return data<ActionResult>(
      { ok: false, error: "Not enough benchmark data for this range yet. Try a different MRR amount." },
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
      className="fh-cap mx-auto max-w-[680px] px-4 py-10 text-center md:px-8 md:py-20" data-cap-site="foxhound"
      data-family="amber"
      data-density="comfortable"
    >
      {/* Bespoke hero, restored per ruling 64: Recova's /audit sits OUTSIDE
          (marketing) and never used MarketingPageHeader. The pill is
          Capsomer's badge in Recova's treatment: mono at 0.75rem with 0.06em
          tracking, amber words on a 13% amber tint inside a 27% amber edge. */}
      <div className="mb-6">
        <span className="cap-pill font-mono text-caption font-normal tracking-[0.06em] [--_bg:color-mix(in_srgb,var(--primary)_13%,transparent)] [--_fg:var(--accent-text)] [--_line:color-mix(in_srgb,var(--primary)_27%,transparent)]">
          FREE LOST REVENUE AUDIT
        </span>
      </div>

      {/* Recova's clamp(28px,5vw,44px) h1, in rem. The words are Recova's,
          drift fixed on sight (RULES.md 2.2): they describe the audit, not the
          estimator, so they hold in every state of the form below. */}
      <h1 className="m-0 mb-5 text-[clamp(1.75rem,5vw,2.75rem)] font-semibold leading-[1.15] tracking-[-1px] text-text">
        See everything leaking from your Stripe account
      </h1>

      <p className="m-0 mb-10 text-product-sub leading-[1.6] text-text-subtle">
        Enter your MRR and customer count for a directional estimate. No signup, no credit card, 30
        seconds.
      </p>

      {/* The estimator: Foxhound's own working surface, which Recova has no
          counterpart for (ruling 86). */}
      <div className="mb-10 grid">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="flex flex-col gap-4 text-left">
              <h2 className="m-0 font-mono text-micro font-normal uppercase tracking-wide text-text-tertiary">
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
                    <EstimatorResultCard result={actionData.result} currency={actionData.currency} />
                  ) : (
                    <EstimatorForm busy={busy} siteKey={turnstileSiteKey} attempt={actionData} />
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      <div className="mb-10 grid">
        <div className="cap-panel">
          <div className="cap-panel-body">
            <p className="m-0 text-left text-label leading-relaxed text-text-tertiary">
              Industry commentary on subscription businesses puts monthly failed-payment revenue leakage
              somewhere in the low single-digit percent of MRR for most accounts, typically higher for
              smaller, lower-touch accounts and lower for larger ones with more mature dunning already
              in place. This estimator uses that same directional range (see the confidence caveat on
              your result), not a claim about your specific account until you connect Stripe.
            </p>
          </div>
        </div>
      </div>

      {/* Recova's covers card: its heading, the four dot lines, "See my
          numbers" full width, and the note under it. Recova's note said
          "Read-only Stripe access" while asking for read_write. Stripe gives
          read_only only to Extensions (2026-10-29), so the audit asks for
          read_write too, and the note says what is true: Foxhound only reads
          and disconnects itself when the window ends (audit-access.ts). */}
      <div className="mb-6 grid">
        {/* Recova's covers card: p-6, p-10 from md, 16px corners. */}
        <section className="cap-panel rounded-2xl [--gap:1.5rem] [--pad-card:1.5rem] md:[--gap:2.5rem] md:[--pad-card:2.5rem]">
          <div className="cap-panel-body">
            <div>
              <h2 className="m-0 mb-5 text-caption font-medium uppercase tracking-[0.06em] text-text-tertiary">
                What the audit covers
              </h2>
              <ul className="m-0 mb-8 list-none p-0">
                {COVERS.map(([title, desc]) => (
                  <li key={title} className="mb-3 flex items-start gap-3 text-left">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden="true" />
                    <span>
                      <span className="mb-0.5 block text-copy font-medium text-text">{title}</span>
                      <span className="block text-label text-text-subtle">{desc}</span>
                    </span>
                  </li>
                ))}
              </ul>

              {/* Recova's full-width button: py-4 at 1rem bold, 10px corners. */}
              <div className="grid">
                <Link
                  to="/audit/connect"
                  className="cap-btn rounded-[10px] font-bold [--cap-btn-fs:var(--text-body)] [--cap-btn-h:3.5rem]"
                  data-variant="primary"
                  data-size="lg"
                >
                  See my numbers
                </Link>
              </div>
              <p className="m-0 mt-2 text-label text-text-subtle">
                {AUDIT_ACCESS_CHIP}. 30 seconds. No account required.
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Recova's two figure cards, restored as treatment (ruling 87). The
          figures carry Foxhound's already-live claims, not Recova's "2 to 3%"
          industry benchmark, which Recova's own comment calls marketing copy.
          Plain panels, not Capsomer's stat tile: a tile is always a link, and
          these lead nowhere. */}
      <div className="my-10 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="cap-panel">
          <div className="cap-panel-body">
            <div>
              <p className="m-0 mb-1 font-mono text-display font-bold text-green">Low single digits</p>
              <p className="m-0 text-caption text-text-subtle">percent of MRR fails every month for most accounts</p>
            </div>
          </div>
        </div>
        <div className="cap-panel">
          <div className="cap-panel-body">
            <div>
              <p className="m-0 mb-1 font-mono text-display font-bold text-blue">$0</p>
              <p className="m-0 text-caption text-text-subtle">cost to run this estimate today</p>
            </div>
          </div>
        </div>
      </div>

      <p className="m-0 mb-4 text-label text-text-subtle">Want to see the app before connecting?</p>
      {/* A 24px target (min-h-6) for a link that stands alone. */}
      <a
        href="/demos/recovery"
        className="inline-flex min-h-6 items-center text-copy text-accent-text no-underline transition-opacity duration-500 hover:opacity-80"
      >
        View live demo &rarr;
      </a>

      <div className="mt-10 grid">
        <div className="cap-panel">
          <div className="cap-panel-body">
            {/* SESSION 71, PHASE (f): the CTA is the audit, which needs no
                account and is the top of PRICING rev 3's funnel; signup is
                what the RESULTS page offers afterwards, which is where Recova
                puts it too. */}
            <div>
              <p className="m-0 mb-2 text-body font-medium text-text">Want your real numbers instead of an estimate?</p>
              <p className="m-0 mb-5 text-label leading-relaxed text-text-secondary">
                Connect Stripe and Foxhound runs the full audit on the spot: what failed and why, what
                is expiring, where your disputes stand, and your recurring revenue. No account needed.
                Foxhound only reads, writes nothing back to Stripe, and disconnects itself after{" "}
                {AUDIT_GRANT_MINUTES} minutes.
              </p>
              <Link to="/audit/connect" className="cap-btn" data-variant="primary">
                Run the free audit
              </Link>
              <p className="m-0 mt-4 font-mono text-micro text-text-subtle">
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
function EstimatorForm({ busy, siteKey, attempt }: { busy: boolean; siteKey: string; attempt: unknown }) {
  const currencyId = useId();
  const widget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !widget.current) return;
    return mountTurnstile(widget.current, siteKey);
  }, [siteKey, attempt]);
  return (
    <Form method="post" className="flex flex-col gap-4">
      <Field label="Monthly recurring revenue (MRR)">
        <input className="cap-input" name="mrr" type="number" autoComplete="off" required />
      </Field>
      <Field label="Active customer count">
        <input className="cap-input" name="customerCount" type="number" autoComplete="off" required />
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

      {/* Full width, as the form's own submit was: the grid stretches it. */}
      <div className="grid">
        <Button type="submit" variant="primary" pending={busy}>
          Estimate my leakage
        </Button>
      </div>
    </Form>
  );
}

function EstimatorResultCard({ result, currency }: { result: EstimatorResult; currency: string }) {
  return (
    <div>
      <p className="m-0 mb-1 font-mono text-micro text-text-subtle">Estimated monthly leakage</p>
      <p className="m-0 mb-3 font-mono text-display font-semibold text-text">
        {formatMoney(result.estimatedLeakageCents, currency)}
      </p>
      <p className="m-0 mb-4 text-label leading-relaxed text-text-secondary">
        Directional estimate, not a precise number: comparable accounts in your MRR band typically show
        {" "}
        {formatMoney(result.low, currency)} to {formatMoney(result.high, currency)} in monthly
        failed-payment leakage. Connect Stripe for your account's actual numbers.
      </p>
      {/* The estimator's own next step: the audit reads the merchant's actual
          account, takes no account to run, and is what this card has been
          promising as "your real numbers" all along. */}
      <Link to="/audit/connect" className="cap-btn" data-variant="primary">
        Run the free audit on your real numbers
      </Link>
    </div>
  );
}
