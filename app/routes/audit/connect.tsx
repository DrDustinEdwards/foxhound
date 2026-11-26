import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { PermissionList } from "capsomer/react/consent";
import type { ReactNode } from "react";
import { Form, redirect, useFormAction, useNavigation } from "react-router";
import { AuthLink } from "~/components/auth-link";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/consent.css";
import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the button, the alert and the focus ring read, as on /connect.
import "~/site-header.css";

import { AUDIT_LOOKBACK_DAYS } from "~/lib/constants";
import { RATE_LIMIT_AUDIT } from "~/lib/http/rate-limit-buckets";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { isIpWithinRateLimit } from "~/lib/http/rate-limit";
import { AUDIT_ACCESS_ASK, AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import { AUDIT_ACTION, buildConnectState } from "~/lib/stripe/connect-state";
import { buildAuditAuthorizeUrl } from "~/lib/stripe/connect";
import { setAuditStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect";
import "~/audit-tool.css";

// The consent page and its OAuth start, one route (React Router gives a page its own action).
// THE SCOPE: Stripe refuses read_only outside Extensions, so the request is read_write and the copy says so: Stripe asks for read and write access, Foxhound only reads, and Foxhound disconnects itself when the window ends (audit-access.ts). "What we never do" lists what Foxhound does not do, not what it cannot.
// The progress ticker keeps only its one true step ("Connecting to Stripe..."), announced through a polite status region; fake later steps would describe work that is not happening, shown to a visitor already on Stripe's consent screen.
// ERRORS LAND HERE, NOT ON /audit: landing back on the consent screen with the reason keeps the retry one click away, where a redirect to /audit would leave the visitor with no explanation.

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

export function meta() {
  return [
    { title: "Connect your Stripe account - Foxhound" },
    // Not indexable: this is a step inside a flow, and the sitemap omits it too. robots.txt carries the same exclusion.
    { name: "robots", content: "noindex" },
  ];
}

const CAN_DO = [
  "View failed invoices and payment history",
  "Scan decline codes and categories",
  "Calculate your recoverable revenue",
];

const CAN_NEVER_DO = [
  "Create new charges or move money",
  "Access your payouts or bank account",
  "Store your Stripe data permanently",
];

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Too many audit attempts from this network. Please try again later.",
  cancelled: "Stripe connection was canceled. Nothing was read.",
  invalid_state: "That audit link expired. Please start again.",
  scope_refused:
    "Stripe did not grant the access the audit asked for, so the run was refused. Nothing was read.",
  failed: "Could not complete the Stripe connection. Please try again.",
  session_expired: "That audit session expired. Connect again to see current numbers.",
};

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return {
    lookbackDays: AUDIT_LOOKBACK_DAYS,
    stripeEnabled: Boolean(env.STRIPE_CLIENT_ID),
    error: new URL(request.url).searchParams.get("error"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);

  // The shared limiter, USED UNCHANGED: 10 per hour on `audit-connect:{ip}`. Fail-open like every other caller.
  const allowed = await isIpWithinRateLimit(env, request, "audit-connect", RATE_LIMIT_AUDIT);
  if (!allowed) return redirect("/audit/connect?error=rate_limited");

  if (!env.STRIPE_CLIENT_ID) {
    return redirect("/audit/connect?error=failed");
  }

  // THE EXISTING STATE SHAPE WITH A NEW ACTION, not a parallel implementation. The cookie is the audit's own (`audit_oauth_state`), so a merchant with a half-finished /connect in another tab keeps it.
  const state = buildConnectState(AUDIT_ACTION);
  return redirect(buildAuditAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setAuditStateCookie(state) },
  });
}

/** The frame: `flex items-center justify-center px-4 py-[60px]` around one `w-full max-w-[480px]` card with `p-12`. The card is Capsomer's panel through its HTML contract, body only, because the React Panel always draws an h2 header band and this page's one heading is its h1. The wrapper puts the parts in Capsomer's amber family with Foxhound's neutrals (.fh-cap). The inner div adds 36px by 32px to the panel body's 12px by 16px, which is 48px on every side at every width, as the sign-in card does. */
function AuditConnectFrame({ children }: { children: ReactNode }) {
  return (
    <div className="fh-auditconnect-row">
      <div
        className="fh-auditconnect-block fh-cap"
        data-cap-site="foxhound"
        data-family="amber"
        data-audit-connect=""
      >
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="fh-auditconnect-block-2">{children}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The one true progress step, shown while the browser leaves for Stripe. */
const PENDING_LABEL = "Connecting to Stripe...";

export default function AuditConnect({ loaderData }: Route.ComponentProps) {
  // Pending only while THIS form's POST is in flight. Any navigation sets the router's state, so following "See a demo first" or a header link would otherwise announce "Connecting to Stripe..." while going somewhere else.
  const navigation = useNavigation();
  const formAction = useFormAction();
  const busy =
    navigation.state !== "idle" &&
    navigation.formMethod?.toUpperCase() === "POST" &&
    navigation.formAction === formAction;
  const message = loaderData.error
    ? (OAUTH_ERROR_MESSAGES[loaderData.error] ?? "Could not connect Stripe. Please try again.")
    : null;

  return (
    <AuditConnectFrame>
      <h1 className="fh-auditconnect-title fh-center fh-title fh-semibold fh-text">
        Connect your Stripe account
      </h1>
      <p className="fh-auditconnect-text fh-center fh-small fh-relaxed fh-quiet">
        {AUDIT_ACCESS_ASK} We only read, to scan your failed payments from the last{" "}
        {loaderData.lookbackDays} days. We disconnect ourselves after {AUDIT_GRANT_MINUTES} minutes
        unless you connect a Foxhound account. We never store your data permanently.
      </p>

      {message ? (
        <div className="fh-auditconnect-block-3">
          <Alert tone="crit">{message}</Alert>
        </div>
      ) : null}

      <div className="fh-auditconnect-grid">
        <PermissionList id="audit-connect-can" heading="What we can do" items={CAN_DO} allowed />
        <PermissionList
          id="audit-connect-cannot"
          heading="What we never do"
          items={CAN_NEVER_DO}
          allowed={false}
        />
      </div>

      {loaderData.stripeEnabled ? (
        <Form method="post">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            wrap
            pending={busy}
            pendingLabel={PENDING_LABEL}
          >
            Connect Stripe and see my numbers<span aria-hidden="true"> →</span>
          </Button>
        </Form>
      ) : (
        <p className="fh-center fh-small fh-quiet">
          Stripe Connect is not configured in this environment yet.
        </p>
      )}

      <p className="fh-auditconnect-text-2 fh-center fh-tiny fh-quiet">
        {"Reads only · Secure · Free · "}
        <AuthLink to="/demos/recovery">See a demo first</AuthLink>
      </p>
    </AuditConnectFrame>
  );
}
