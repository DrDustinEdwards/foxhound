import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/status.css";
import { Panel } from "capsomer/react/panel";
import { and, eq } from "drizzle-orm";
import { redirect } from "react-router";
import { Link } from "capsomer/react/link";

import { ChecklistStatus, StaticRow } from "~/components/recovery-dashboard-panels";
import { accounts, getDb, stripeConnections } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/welcome";

// Row A8, /welcome (J28). Recova's app/welcome/page.tsx (blob f0181a74) and
// WelcomeClient.tsx (blob a9489188), read whole. The landing after a NEW Stripe
// connection: the Stripe callback sends /welcome?connection=<id> (Foxhound's
// connect-callback.ts, Recova's app/api/auth/stripe/callback/route.ts), and
// without that id, or with one the account does not hold, the page goes to
// /console. It shows "You're connected.", the connection's name (or its Stripe
// id), one line, Recova's "Two quick steps" (sender name, notification email)
// and the way on to the Recovery dashboard. Inside the dashboard frame, so the
// parts are Capsomer's (Q10): the panel and the rows the dashboard's own
// getting-started checklist uses.
//
// Recova's app/api/welcome/activate route (blob b6bbc549) is not ported:
// nothing in Recova calls it (WelcomeClient posts nothing), and the
// account_products table it writes was dropped (ruling 298).

export function meta() {
  return [{ title: "Welcome - Foxhound" }];
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
      .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)))
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
    <div className="mx-auto max-w-[640px] px-4 py-16 md:px-8">
      <div className="mb-10 text-center">
        <h1 className="m-0 mb-2 text-section font-medium text-text">You&apos;re connected.</h1>
        <div className="mb-6 font-mono text-copy text-text-tertiary">{connectionLabel}</div>
        <p className="m-0 text-subhead leading-[1.6] text-text">
          Recovery is active. No commitment. Nothing until we recover.
        </p>
      </div>

      <div className="mb-8">
        <Panel title="Two quick steps">
          <ul className="cap-rows" role="list" data-gap="sm">
            <StaticRow
              status={<ChecklistStatus done={senderNameSet} />}
              title="Set your sender name"
              detail="The name customers see in recovery emails."
              actions={
                senderNameSet ? null : (
                  <Link to="/settings" className="cap-btn" data-size="sm">
                    Open settings
                  </Link>
                )
              }
            />
            <StaticRow
              status={<ChecklistStatus done={notificationEmailSet} />}
              title="Set your notification email"
              detail="We'll alert you when a payment is recovered."
              actions={
                notificationEmailSet ? null : (
                  <Link to="/settings" className="cap-btn" data-size="sm">
                    Open settings
                  </Link>
                )
              }
            />
          </ul>
        </Panel>
      </div>

      <div className="text-center">
        <Link
          to="/recovery/dashboard"
          className="cap-btn font-mono"
          data-variant={allDone ? "primary" : undefined}
          data-size="lg"
        >
          {allDone ? "Go to dashboard" : "Skip for now → Dashboard"}
        </Link>
        {allDone ? null : (
          <p className="m-0 mt-3 text-caption text-text-subtle">You can finish these later from the dashboard.</p>
        )}
      </div>
    </div>
  );
}
