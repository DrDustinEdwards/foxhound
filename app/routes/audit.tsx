import { data, Form, Link, useNavigation } from "react-router";

import { Alert, Field, Submit } from "~/components/auth-ui";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { AUDIT_LOOKBACK_DAYS } from "~/lib/constants";
import { estimateLeakage, recordEstimatorRun, type EstimatorResult } from "~/lib/estimator/estimate.server";
import { formatMoney } from "~/lib/money-format";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";
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

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Free Stripe Revenue Leakage Audit - Foxhound",
    description:
      "Estimate what your Stripe account is leaking to failed payments in 30 seconds. No signup, no credit card. Connect Stripe afterward to see your real numbers.",
    path: "/audit",
    siteUrl: loaderData?.siteUrl ?? "",
  });
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
    <div className="mx-auto max-w-[680px] px-4 py-10 text-center md:px-8 md:py-20">
      {/* Bespoke hero, restored per ruling 64: legacy's /audit sits OUTSIDE
          (marketing) and never used MarketingPageHeader. Foxhound had flattened
          it onto the shared header, ruling 63's pattern. The h1 clamp is
          legacy's, converted px to rem (Dustin, ruling 85): identical at a 16px
          root, and unlike px it responds to a user's font-size setting. */}
      <div className="mb-6 inline-block rounded-full border border-[rgb(from_var(--amber)_r_g_b_/_0.27)] bg-[rgb(from_var(--amber)_r_g_b_/_0.13)] px-3 py-1 font-mono text-xs tracking-[0.06em] text-amber-text">
        FREE LOST REVENUE AUDIT
      </div>

      <h1 className="m-0 mb-5 text-[clamp(1.75rem,5vw,2.75rem)] font-semibold leading-[1.15] tracking-[-1px]">
        See what your Stripe account is leaking
      </h1>

      <p className="m-0 mb-10 text-product-sub leading-[1.6] text-text-subtle">
        Enter your MRR and customer count for a directional estimate. No signup, no credit card, 30
        seconds.
      </p>

      <div>
        <div className="mb-10 rounded-lg border border-border bg-surface p-6 text-left">
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

        <div className="mb-10 rounded-lg border border-border-sub bg-surface2 px-4 py-3 text-left text-label leading-relaxed text-text-tertiary">
          Industry commentary on subscription businesses puts monthly failed-payment revenue leakage
          somewhere in the low single-digit percent of MRR for most accounts, typically higher for
          smaller, lower-touch accounts and lower for larger ones with more mature dunning already in
          place. This estimator uses that same directional range (see the confidence caveat on your
          result), not a claim about your specific account until you connect Stripe.
        </div>

        {/* Legacy's single covers CARD with a dot list, replacing a 2-up grid of
            bordered sub-cards Foxhound had.

            UN-RESTATED IN SESSION 71, PHASE (f), which is what session 66's
            restatement was waiting for. 66 rewrote this section because
            NOTHING IN FOXHOUND RAN AN AUDIT: no engine, no trigger, no row.
            Phases (a) to (e) built the engine, the summary, the persistence and
            the two authenticated surfaces, and (f) built the door. A visitor can
            now click the button below, authorize read-only, and get all four of
            these computed from their own live Stripe account.

            So the CLAIM goes back to describing the audit, and the heading with
            it. Two clauses of legacy's own copy are still NOT restored, because
            they name renders Foxhound does not have: legacy's "estimated
            recoverable amount" comes from AUDIT_RECOVERY_ESTIMATE_PCT and its
            dispute "historical win rate" is a platform figure, both NOT PORTED
            at 365 binding 31. The expiring-cards line says what the engine's
            predicate actually does, which includes already-expired cards; legacy
            says "next 30 days" and counts them too.

            FOUR LINES, NOT SIX, and that is legacy's editorial call matched
            rather than an omission. Both engines compute six scopes; legacy's
            card lists four and folds past-due subscriptions and the Card Updater
            advisory into the run itself. Both render on the results page. */}
        <div className="mb-6 rounded-2xl border border-border bg-surface p-6 md:p-10">
          <div className="mb-5 text-xs font-medium uppercase tracking-[0.06em] text-text-tertiary">
            What the audit covers
          </div>
          <div>
            {[
              [
                "Failed invoices",
                `Payments Stripe marked uncollectible in the last ${AUDIT_LOOKBACK_DAYS} days, and the decline reason behind each one.`,
              ],
              [
                "Expiring cards",
                "Customers whose card has expired or expires within the next month, and the MRR at risk before those payments fail.",
              ],
              [
                "Open disputes",
                "Unmanaged chargebacks, your won and lost record, and revenue accepted without evidence submission.",
              ],
              [
                "Business health",
                "MRR, ARR, active subscriptions, voluntary versus involuntary churn rate.",
              ],
            ].map(([title, desc]) => (
              <div key={title} className="mb-3 flex items-start gap-3 text-left">
                <div className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
                <div>
                  <div className="mb-0.5 text-sm font-medium text-text">{title}</div>
                  <div className="text-label text-text-subtle">{desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Legacy's in-card CTA, restored with its route. Session 66 recorded
              it as NOT ported because /audit/connect did not exist; it does. */}
          <Link
            to="/audit/connect"
            className="mb-2 mt-8 block rounded-[10px] bg-amber px-8 py-4 text-base font-bold text-on-amber no-underline hover:bg-amber-dark"
          >
            See my numbers
          </Link>
          <div className="mt-2 text-label text-text-subtle">
            Read-only Stripe access. 30 seconds. No account required.
          </div>
        </div>

        {/* Legacy's two stat cards, restored as treatment (ruling 87). The
            figures carry Foxhound's already-live claims, not legacy's "2 to 3%"
            industry benchmark, which legacy's own comment calls marketing copy;
            the short-form wording is recorded for ruling 20d's pass. */}
        <div className="my-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-[12px] border border-border bg-surface p-5">
            <div className="mb-1 font-mono text-[1.75rem] font-bold text-green">Low single digits</div>
            <div className="text-xs text-text-subtle">percent of MRR fails every month for most accounts</div>
          </div>
          <div className="rounded-[12px] border border-border bg-surface p-5">
            <div className="mb-1 font-mono text-[1.75rem] font-bold text-blue">$0</div>
            <div className="text-xs text-text-subtle">cost to run this estimate today</div>
          </div>
        </div>

        <div className="mb-4 text-label text-text-subtle">Want to see the app before connecting?</div>
        <a
          href="/demos/recovery"
          className="text-sm text-amber-text no-underline transition-opacity duration-500 hover:opacity-80"
        >
          View live demo &rarr;
        </a>

        <div className="mt-10 rounded-lg border border-border bg-surface p-6 text-center">
          {/* SESSION 71, PHASE (f): the second half of session 66's restatement
              coming back. 66 pointed this at /signup because the audit could not
              be run, so the honest offer was the product rather than the
              diagnostic. The diagnostic exists now, needs no account, and is the
              top of PRICING rev 3's funnel, so the CTA is the audit again and
              signup is what the RESULTS page offers afterwards, which is where
              legacy puts it too. */}
          <p className="mb-2 text-body font-medium text-text">Want your real numbers instead of an estimate?</p>
          <p className="mb-5 text-label leading-relaxed text-text-secondary">
            Connect Stripe read-only and Foxhound runs the full audit on the spot: what failed and
            why, what is expiring, where your disputes stand, and your recurring revenue. No account
            needed, and nothing is written back to Stripe.
          </p>
          <Link
            to="/audit/connect"
            className="inline-flex items-center gap-2 rounded-md bg-amber px-5 py-2.5 text-label font-medium text-on-amber hover:bg-amber-dark"
          >
            Run the free audit
          </Link>
          <div className="mt-4 font-mono text-micro text-text-subtle">
            No account required &middot; The audit only reads &middot; Nothing is stored
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
      {/* The estimator's own next step, repointed in phase (f). An estimate
          built from an MRR band is a directional guess; the audit reads the
          merchant's actual account, takes no account to run, and is what this
          card has been promising as "your real numbers" all along. */}
      <Link
        to="/audit/connect"
        className="inline-flex items-center gap-2 rounded-md bg-amber px-5 py-2.5 text-label font-medium text-on-amber hover:bg-amber-dark"
      >
        Run the free audit on your real numbers
      </Link>
    </div>
  );
}
