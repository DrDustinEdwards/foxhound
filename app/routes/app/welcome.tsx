import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/status.css";
import { SetupChecklist } from "capsomer/react/setup-checklist";
import { and, eq } from "drizzle-orm";
import { redirect } from "react-router";
import { ButtonLink } from "capsomer/react/link";
import { accounts, getDb, stripeConnections } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import type { Route } from "./+types/welcome";
import { NOINDEX } from "~/lib/seo/meta";

// Row A8, /welcome. Recova's app/welcome/page.tsx (blob f0181a74) and
// WelcomeClient.tsx (blob a9489188), read whole. The landing after a NEW Stripe
// connection: the Stripe callback sends /welcome?connection=<id> (Foxhound's
// connect-callback.ts, Recova's app/api/auth/stripe/callback/route.ts), and
// without that id, or with one the account does not hold, the page goes to
// /console. It shows "You're connected.", the connection's name (or its Stripe
// id), one line, Recova's "Two quick steps" (sender name, notification email)
// and the way on to the Recovery dashboard. Inside the dashboard frame, so the
// parts are Capsomer's: the setup checklist the dashboard's own getting
// started panel uses.
//
// Recova's app/api/welcome/activate route (blob b6bbc549) is not ported:
// nothing in Recova calls it (WelcomeClient posts nothing), and the
// account_products table it writes was dropped.

export function meta() {
  return [{ title: "Welcome - Foxhound" }, NOINDEX];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const connectionId = new URL(request.url).searchParams.get("connection");
  if (!connectionId) throw redirect("/console");

  const db = getDb(env);
  const [[connection], [account]] = await Promise.all([
    db
      .select({
        name: stripeConnections.name,
        stripeUserId: stripeConnections.stripeUserId,
        senderName: stripeConnections.senderName,
      })
      .from(stripeConnections)
      .where(
        and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)),
      )
      .limit(1),
    db
      .select({ notificationEmail: accounts.notificationEmail })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
  ]);
  if (!connection) throw redirect("/console");

  // Only whether each is set crosses to the page, never the address.
  return {
    connectionLabel: connection.name || connection.stripeUserId,
    senderNameSet: !!connection.senderName,
    notificationEmailSet: !!account?.notificationEmail,
  };
}

export default function WelcomePage({ loaderData }: Route.ComponentProps) {
  const { connectionLabel, senderNameSet, notificationEmailSet } = loaderData;
  const allDone = senderNameSet && notificationEmailSet;

  return (
    <div className="fh-welcome">
      <div className="fh-welcome-head fh-center">
        <h1 className="fh-welcome-title fh-section fh-medium fh-text">You&apos;re connected.</h1>
        <div className="fh-welcome-account fh-mono fh-copy fh-quiet">{connectionLabel}</div>
        <p className="fh-welcome-lede fh-subhead fh-text">
          Recovery is active. No commitment. Nothing until we recover.
        </p>
      </div>

      <div className="fh-welcome-steps">
        <SetupChecklist
          title="Two quick steps"
          steps={[
            {
              id: "sender",
              title: "Set your sender name",
              detail: "The name customers see in recovery emails.",
              done: senderNameSet,
              action: (
                <ButtonLink to="/settings" size="sm">
                  Open settings
                </ButtonLink>
              ),
            },
            {
              id: "alerts",
              title: "Set your notification email",
              detail: "We'll alert you when a payment is recovered.",
              done: notificationEmailSet,
              action: (
                <ButtonLink to="/settings" size="sm">
                  Open settings
                </ButtonLink>
              ),
            },
          ]}
        />
      </div>

      <div className="fh-center fh-center">
        <ButtonLink
          to="/recovery/dashboard"
          className="fh-mono"
          variant={allDone ? "primary" : undefined}
          size="lg"
        >
          {allDone ? "Go to dashboard" : "Skip for now → Dashboard"}
        </ButtonLink>
        {allDone ? null : (
          <p className="fh-welcome-note fh-caption fh-faint">
            You can finish these later from the dashboard.
          </p>
        )}
      </div>
    </div>
  );
}
