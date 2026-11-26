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
import { noindexMeta } from "~/lib/seo/meta";

// /welcome: the landing after a NEW Stripe connection. The Stripe callback sends /welcome?connection=<id> (connect-callback.ts); without that id, or with one the account does not hold, the page goes to /console. It shows "You're connected.", the connection's name (or its Stripe id), one line, "Three quick steps" (sender name, notification email, customer emails on) and the way on to the Recovery dashboard, using the setup checklist the dashboard's getting-started panel uses.

export const meta = noindexMeta("Welcome - Foxhound");

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
      .select({
        notificationEmail: accounts.notificationEmail,
        liveSendsEnabled: accounts.liveSendsEnabled,
      })
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
    customerEmailsOn: !!account?.liveSendsEnabled,
  };
}

export default function WelcomePage({ loaderData }: Route.ComponentProps) {
  const { connectionLabel, senderNameSet, notificationEmailSet, customerEmailsOn } = loaderData;
  const allDone = senderNameSet && notificationEmailSet && customerEmailsOn;

  return (
    <div className="fh-welcome">
      <div className="fh-mb-7-5 fh-center">
        <h1 className="fh-mb-3 fh-section fh-medium fh-text">You&apos;re connected.</h1>
        <div className="fh-mb-6 fh-mono fh-copy fh-quiet">{connectionLabel}</div>
      </div>

      <div className="fh-mb-7">
        <SetupChecklist
          title="Three quick steps"
          steps={[
            {
              id: "sender",
              title: "Set your sender name",
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
              done: notificationEmailSet,
              action: (
                <ButtonLink to="/settings" size="sm">
                  Open settings
                </ButtonLink>
              ),
            },
            {
              id: "customer-emails",
              title: "Turn on customer emails",
              done: customerEmailsOn,
              action: (
                <ButtonLink to="/settings/email" size="sm">
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
      </div>
    </div>
  );
}
