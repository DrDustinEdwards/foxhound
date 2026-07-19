import { data, Form, Link, useNavigation } from "react-router";

import { Alert, Field, Submit } from "~/components/auth-ui";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { estimateLeakage, recordEstimatorRun, type EstimatorResult } from "~/lib/estimator/estimate.server";
import { formatMoney } from "~/lib/money-format";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { verifyTurnstileToken } from "~/lib/turnstile/verify.server";

import type { Route } from "./+types/audit";

// Real no-auth estimator + audit marketing page (Phase 6 Pass 3). Ported the
// legacy app/audit/page.tsx marketing structure (Capsid read_repo_file,
// namespace recova, repo legacy), replacing the earlier Pass-1 RouteStub.
// Corrections vs legacy, matching this repo's established audit copy
// discipline (products/audit.tsx): no fabricated recovery-rate stat, and the
// old bare "2 to 3% of MRR fails every month" marketing figure is replaced
// with our own seeded, source-cited benchmark_data range rather than an
// unsourced number.
//
// JUDGMENT CALL (flagged per the task): ROUTES.md documents ONE flow, "/audit,
// no-auth estimator (Turnstile) -> Stripe connect -> full audit report", with
// no separately listed authenticated audit route, and this repo's /connect
// (app/routes/auth/connect.tsx) already requires an existing session (it
// redirects to /login otherwise). Building a parallel no-login Stripe OAuth
// start would be new authenticated-adjacent surface ROUTES.md does not
// document, so the "connect Stripe" step after the estimator points at the
// existing /signup entry point instead, which is the real path into
// /connect today. The full-audit lift-band computation itself is built as a
// data/query layer only (app/lib/audit/full-audit.server.ts), not wired to
// any new route or UI.

export function meta() {
  return [
    { title: "Free Stripe Revenue Leakage Audit - Foxhound" },
    {
      name: "description",
      content:
        "Estimate what your Stripe account is leaking to failed payments in 30 seconds. No signup, no credit card. Connect Stripe afterward for the full diagnostic.",
    },
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

export default function AuditPage({ loaderData, actionData }: Route.ComponentProps) {
  const { siteUrl: url, turnstileAvailable, turnstileSiteKey } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div>
      <MarketingPageHeader
        eyebrow="Free lost revenue audit"
        title="See what your Stripe account is leaking"
        subtext="Enter your MRR and customer count for a directional estimate. No signup, no credit card, 30 seconds."
      />

      <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-8">
        <div className="mb-10 rounded-lg border border-border bg-surface p-6">
          <p className="mb-4 font-mono text-micro uppercase tracking-wide text-text-tertiary">
            Free leakage estimator
          </p>

          {!turnstileAvailable ? (
            <Alert tone="error">
              The estimator is temporarily unavailable while verification is being configured. Please
              check back soon, or run the full audit by connecting Stripe directly.
            </Alert>
          ) : (
            <>
              {actionData && !actionData.ok ? <Alert tone="error">{actionData.error}</Alert> : null}

              {actionData?.ok ? (
                <EstimatorResultCard result={actionData.result} currency={actionData.currency} />
              ) : (
                <Form method="post" className="flex flex-col gap-4">
                  <Field label="Monthly recurring revenue (MRR)" name="mrr" type="number" autoComplete="off" />
                  <Field label="Active customer count" name="customerCount" type="number" autoComplete="off" />
                  <label className="flex flex-col gap-1.5">
                    <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Currency</span>
                    <select
                      name="currency"
                      defaultValue="usd"
                      className="rounded-md border border-border bg-surface px-3 py-2 text-body text-text focus-visible:border-amber"
                    >
                      <option value="usd">USD</option>
                      <option value="eur">EUR</option>
                      <option value="gbp">GBP</option>
                      <option value="cad">CAD</option>
                      <option value="aud">AUD</option>
                    </select>
                  </label>

                  <div className="cf-turnstile" data-sitekey={turnstileSiteKey} />

                  <Submit disabled={busy}>{busy ? "Estimating..." : "Estimate my leakage"}</Submit>
                </Form>
              )}
            </>
          )}
        </div>

        <div className="mb-10 rounded-lg border border-border-sub bg-surface2 px-4 py-3 text-label leading-relaxed text-text-tertiary">
          Industry commentary on subscription businesses puts monthly failed-payment revenue leakage
          somewhere in the low single-digit percent of MRR for most accounts, typically higher for
          smaller, lower-touch accounts and lower for larger ones with more mature dunning already in
          place. This estimator uses that same directional range (see the confidence caveat on your
          result), not a claim about your specific account until you connect Stripe.
        </div>

        <section className="mb-10">
          <h2 className="mb-4 text-title font-medium text-text">What the full audit covers</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              ["Failed invoices", "What is unrecovered right now, and the estimated recoverable amount."],
              ["Expiring cards", "Customers whose cards expire soon, and the MRR at risk before failures happen."],
              ["Open disputes", "Unmanaged chargebacks and revenue at risk without evidence submitted."],
              ["Business health", "MRR, ARR, active subscriptions, voluntary vs. involuntary churn."],
            ].map(([title, desc]) => (
              <div key={title} className="rounded-lg border border-border bg-surface p-4">
                <p className="mb-1 text-label font-medium text-text">{title}</p>
                <p className="text-label leading-relaxed text-text-tertiary">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="rounded-lg border border-border bg-surface p-6 text-center">
          <p className="mb-2 text-body font-medium text-text">Want the full diagnostic against your real account?</p>
          <p className="mb-5 text-label leading-relaxed text-text-secondary">
            Create a free account, then connect Stripe with read-only access for the full report: what
            Stripe already recovered, what is still dying, and what Foxhound would add.
          </p>
          <Link
            to="/signup"
            className="inline-flex items-center gap-2 rounded-md bg-amber px-5 py-2.5 text-label font-medium text-on-amber hover:bg-amber-dark"
          >
            Create a free account
          </Link>
          <div className="mt-4 font-mono text-micro text-text-subtle">
            No credit card &middot; Read-only Stripe access &middot; Disconnect anytime
          </div>
        </div>
      </div>

      {turnstileAvailable ? (
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      ) : null}

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Audit", path: "/audit" },
            ]),
          ),
        }}
      />
    </div>
  );
}

function EstimatorResultCard({ result, currency }: { result: EstimatorResult; currency: string }) {
  return (
    <div>
      <p className="mb-1 font-mono text-micro text-text-subtle">Estimated monthly leakage</p>
      <p className="mb-3 font-mono text-display font-semibold text-text">
        {formatMoney(result.estimatedLeakageCents, currency)}
      </p>
      <p className="mb-4 text-label leading-relaxed text-text-secondary">
        Directional estimate, not a precise number: comparable accounts in your MRR band typically show
        {" "}
        {formatMoney(result.low, currency)} to {formatMoney(result.high, currency)} in monthly
        failed-payment leakage. Connect Stripe for your account's actual numbers.
      </p>
      <Link
        to="/signup"
        className="inline-flex items-center gap-2 rounded-md bg-amber px-5 py-2.5 text-label font-medium text-on-amber hover:bg-amber-dark"
      >
        Create a free account to see your real numbers
      </Link>
    </div>
  );
}
