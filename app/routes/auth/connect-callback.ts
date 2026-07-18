import { and, eq } from "drizzle-orm";
import { redirect } from "react-router";

import { accounts, getDb, stripeConnections } from "~/db";
import { getSession, resolveMembership } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { executeMoneyWrite } from "~/lib/money/execute";
import {
  exchangeConnectCode,
  fetchConnectedAccountName,
} from "~/lib/stripe/connect";
import { encryptToken } from "~/lib/stripe/encryption";
import { clearStateCookie, readStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect-callback";

// Stripe Connect OAuth callback (ROUTES.md: /connect/callback). Stripe redirects
// here with ?code&state after the merchant authorizes. This is the real token
// exchange Phase 3 stubbed. The account already exists (Phase 3 setup), so we
// attach the connection to the resolved account and write stripe_connections
// through the per-account money-write Durable Object (ARCHITECTURE.md: token
// encrypted, never logged).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const bounce = (reason: string) =>
    redirect(`/connect?error=${reason}`, {
      headers: { "Set-Cookie": clearStateCookie() },
    });

  if (oauthError) return bounce("denied");
  if (!code) return bounce("no_code");

  // CSRF: the state param must match the cookie set at flow start.
  const cookieState = readStateCookie(request);
  if (!state || !cookieState || state !== cookieState) {
    return bounce("invalid_state");
  }

  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  const membership = await resolveMembership(db, session.user.id);
  if (!membership) return bounce("no_code"); // no account to attach to; back to setup

  try {
    const oauth = await exchangeConnectCode(env, code);
    const encryptedToken = await encryptToken(env, oauth.accessToken);
    const accountName = await fetchConnectedAccountName(env, oauth.stripeUserId);
    const now = new Date();

    // Reconnect vs first connect: if this Stripe account is already attached to
    // this Foxhound account, refresh its token; otherwise insert. The read is
    // safe under the per-account DO serialization (no concurrent writer for this
    // account). Connect is not fee-bearing, so a fresh idempotency key per
    // callback lets a genuine reconnect update the token.
    const existing = await db
      .select({ id: stripeConnections.id })
      .from(stripeConnections)
      .where(
        and(
          eq(stripeConnections.accountId, membership.accountId),
          eq(stripeConnections.stripeUserId, oauth.stripeUserId),
        ),
      )
      .limit(1);

    const idempotencyKey = `connect:${membership.accountId}:${oauth.stripeUserId}:${now.getTime()}`;

    await executeMoneyWrite(env, {
      accountId: membership.accountId,
      idempotencyKey,
      build: (tx) =>
        existing.length > 0
          ? [
              tx
                .update(stripeConnections)
                .set({
                  stripeAccessToken: encryptedToken,
                  stripePublishableKey: oauth.publishableKey,
                  stripeScope: oauth.scope,
                  connectedAt: now,
                  disconnectedAt: null,
                })
                .where(eq(stripeConnections.id, existing[0].id)),
            ]
          : [
              tx.insert(stripeConnections).values({
                accountId: membership.accountId,
                stripeUserId: oauth.stripeUserId,
                stripeAccessToken: encryptedToken,
                stripePublishableKey: oauth.publishableKey,
                stripeScope: oauth.scope,
                name: accountName,
                isPrimary: true,
                connectedAt: now,
                createdAt: now,
              }),
            ],
    });

    const [accountRow] = await db
      .select({ onboardingCompleted: accounts.onboardingCompleted })
      .from(accounts)
      .where(eq(accounts.id, membership.accountId))
      .limit(1);
    const destination = accountRow?.onboardingCompleted ? "/dashboard" : "/welcome";

    return redirect(destination, {
      headers: { "Set-Cookie": clearStateCookie() },
    });
  } catch {
    // Do not log the error object: it can carry request context. The Stripe SDK
    // never surfaces the decrypted token here, but stay conservative.
    return bounce("token_exchange_failed");
  }
}
