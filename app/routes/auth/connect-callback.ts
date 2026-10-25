import { and, eq } from "drizzle-orm";
import { redirect } from "react-router";

import { accountMembers, accounts, getDb, stripeConnections } from "~/db";
import type { Db } from "~/db";
import {
  getSession,
  listMemberships,
  resolveActiveMembershipFrom,
  setSessionActiveAccount,
} from "~/lib/auth";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { executeMoneyWrite } from "~/lib/money/execute";
import {
  exchangeConnectCode,
  fetchConnectedAccountName,
  type StripeOAuthResult,
} from "~/lib/stripe/connect";
import { ADD_ACCOUNT_ACTION, AUDIT_ACTION, verifyConnectState } from "~/lib/stripe/connect-state";
import { encryptToken } from "~/lib/stripe/encryption";
import { findLiveAttachment } from "~/lib/stripe/connections.server";
import { clearStateCookie, readStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect-callback";

// Stripe Connect OAuth callback (ROUTES.md: /connect/callback). Stripe redirects
// here with ?code&state after the merchant authorizes, and every path out of it
// writes `stripe_connections` through the per-account money-write Durable Object
// (ARCHITECTURE.md: token encrypted, never logged).
//
// TWO BRANCHES AS OF RULING 329 PHASE (d), chosen by the state's own action, and
// the split is legacy's: app/api/auth/stripe/callback/route.ts (blob `c60331af`,
// 14,176 bytes) runs its `add_account` branch at :176-250 and its default branch
// at :252-286.
//
//   "add_account"  mints a WHOLE NEW account and attaches the Stripe account to
//                  it. Legacy's intent, ported.
//   "connect"      attaches to the account the caller is ACTIVELY looking at.
//
// THE SECOND LINE IS THE PHASE (e) HAZARD DYING. This resolved with
// `resolveMembership`, the null-marker shim, so it attached to the caller's
// EARLIEST membership. With a switcher shipped, a merchant on account B got
// their Stripe account bolted onto account A, permanently, and the correctly
// account-keyed webhook layer would have honoured it forever
// (parity/MULTI-ACCOUNT-QUERY-AUDIT.md's single riskiest query). It now resolves
// through the session marker like every other authenticated surface.
//
// LEGACY'S DEFAULT BRANCH IS NOT PORTED WHOLE. Its upsert is keyed
// `onConflict: 'stripe_user_id'`, so reconnecting a Stripe account that belongs
// to a DIFFERENT Foxhound account silently moves it. Foxhound refuses that
// instead, class (c) on a legacy defect.
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

  // The whole trust decision, before the code is exchanged and before anything
  // is read or written: the state must be one WE minted (byte-identical to the
  // HttpOnly cookie) and must name a known action. See verifyConnectState for
  // why the comparison is on raw strings.
  const action = verifyConnectState(state, readStateCookie(request));
  if (!action) return bounce("invalid_state");
  // AND IT MUST NOT BE THE AUDIT'S. Phase (f) added a third action to the shared
  // state shape, and this is the half of that decision that lives here: a state
  // minted by the anonymous read-only flow is refused BEFORE the exchange, so a
  // read-only audit grant can never reach the branch that attaches a connection
  // or mints an account. The audit callback refuses the other two symmetrically.
  // Neither cookie can carry the other's state today, since the two flows use
  // different cookie names; this refuses on the payload as well, so the guard
  // does not depend on that staying true.
  if (action === AUDIT_ACTION) return bounce("invalid_state");

  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  const memberships = await listMemberships(db, session.user.id);

  try {
    const oauth = await exchangeConnectCode(env, code);

    return action === ADD_ACCOUNT_ACTION
      ? await addAccount(env, db, session.session.id, session.user.id, memberships, oauth)
      : await attachToActiveAccount(env, db, session.session.activeAccountId ?? null, memberships, oauth);
  } catch {
    // Do not log the error object: it can carry request context. The Stripe SDK
    // never surfaces the decrypted token here, but stay conservative.
    return bounce("token_exchange_failed");
  }
}

// findLiveAttachment MOVED IN PHASE (f) to app/lib/stripe/connections.server.ts,
// unchanged, because a third caller appeared: the anonymous audit's live results
// page, which is a `.tsx` route with a default export. Importing the predicate
// from THIS module put the database, the money-write executor and the token
// encryption on that page's client graph.
//
// IT IS NOT RE-EXPORTED FROM HERE, and the reason is worth keeping: a re-export
// is a NON-loader export of a route module, so the dot-server guard rejects it
// outright ("other route exports depend on a server-only module"). Attempting
// the re-export to spare one test its import path is what proved that, and the
// guard was right. 356's tests import the predicate from its module.

/**
 * Where a merchant lands, as Recova's callback decides it (J28, row A8): a NEW
 * connection goes to /welcome?connection=<its id>, anything else (a reconnect,
 * or a Stripe account the caller already holds) to /console. The welcome page
 * needs the id and goes to /console without it, as Recova's does.
 */
function destinationFor(newConnectionId: string | null): string {
  return newConnectionId ? `/welcome?connection=${encodeURIComponent(newConnectionId)}` : "/console";
}

/** Land on `accountId` with this session pointed at it. */
async function landOn(
  db: Db,
  sessionId: string,
  accountId: string,
  newConnectionId: string | null,
): Promise<Response> {
  await setSessionActiveAccount(db, sessionId, accountId);
  return redirect(destinationFor(newConnectionId), {
    headers: { "Set-Cookie": clearStateCookie() },
  });
}

/**
 * Legacy's `add_account` branch (:176-250): a new account, its connection, its
 * owner membership, and the active-account marker moved to it.
 *
 * ONE `executeMoneyWrite`, KEYED ON THE NEW ACCOUNT ID, which is why the id is
 * minted here rather than by the database: the money-write Durable Object is
 * named by that id, so the id has to exist before the write that creates the row
 * it names. Every statement lands in that one atomic batch, so a merchant can
 * never end up with an account row that has no owner, or a connection whose
 * account does not exist.
 *
 * NEITHER BILLING NOR PRODUCTS ROWS ARE CREATED, and that is Foxhound's shape
 * rather than an omission. Legacy's branch calls `ensureBillingCustomer` and
 * `ensureAccountProducts`; `account_products` was DROPPED at ruling 298 as
 * vestigial, and `accounts.platform_stripe_customer_id` is written by the
 * billing-setup path, not at connect. `createAccountForUser` creates exactly an
 * account row and an owner membership, and this creates the same pair plus the
 * connection, so there is one definition of what a new account is.
 */
async function addAccount(
  env: Env,
  db: Db,
  sessionId: string,
  userId: string,
  memberships: { accountId: string }[],
  oauth: StripeOAuthResult,
): Promise<Response> {
  // Is this Stripe account already live somewhere? Asked BEFORE anything is
  // written and before any further Stripe call, through the one predicate both
  // branches share.
  const attachment = await findLiveAttachment(
    db,
    oauth.stripeUserId,
    memberships.map((m) => m.accountId),
  );

  if (attachment.status === "held_by_caller") {
    // Already theirs. Legacy would upsert and, from the switcher's "+ Add
    // account", mint a duplicate account around a connection that already
    // exists. Take them to the account instead and write nothing: a merchant who
    // re-runs add-account for a Stripe account they already added has asked to
    // go there, not to have a second empty account. Ruling 330 binding 2, class
    // (c) truthfulness fix, unchanged by this session.
    return landOn(db, sessionId, attachment.accountId, null);
  }

  if (attachment.status === "held_elsewhere") {
    // Live on an account this user does NOT hold. Refuse, and say only that it
    // is already connected: naming the account, or even confirming which one,
    // would leak another merchant's tenancy to whoever controls the Stripe
    // account (329 R3). No account id, no hint.
    return bounceTo("/connect?error=stripe_account_already_connected");
  }

  const accountId = crypto.randomUUID();
  // Minted here, like the account id, so the welcome page can be sent to it.
  const connectionId = crypto.randomUUID();
  const encryptedToken = await encryptToken(env, oauth.accessToken);
  const accountName = await fetchConnectedAccountName(env, oauth.stripeUserId);
  const now = new Date();

  await executeMoneyWrite(env, {
    accountId,
    idempotencyKey: `add-account:${accountId}`,
    build: (tx) => [
      tx.insert(accounts).values({ id: accountId, name: accountName, createdAt: now }),
      tx.insert(stripeConnections).values({
        id: connectionId,
        accountId,
        stripeUserId: oauth.stripeUserId,
        stripeAccessToken: encryptedToken,
        stripePublishableKey: oauth.publishableKey,
        stripeScope: oauth.scope,
        name: accountName,
        isPrimary: true,
        connectedAt: now,
        createdAt: now,
      }),
      tx.insert(accountMembers).values({
        id: crypto.randomUUID(),
        accountId,
        userId,
        role: MEMBER_ROLE.OWNER,
        status: MEMBER_STATUS.ACTIVE,
        createdAt: now,
      }),
    ],
  });

  return landOn(db, sessionId, accountId, connectionId);
}

/**
 * Legacy's default branch (:252-286): attach or reconnect on an account the
 * caller already holds.
 *
 * THE ACCOUNT IS THE ACTIVE ONE, resolved through the session marker by
 * `resolveActiveMembershipFrom`, never the earliest by the shim. That single
 * substitution is what closes the phase (e) hazard.
 */
async function attachToActiveAccount(
  env: Env,
  db: Db,
  activeAccountId: string | null,
  memberships: Awaited<ReturnType<typeof listMemberships>>,
  oauth: StripeOAuthResult,
): Promise<Response> {
  const membership = await resolveActiveMembershipFrom(db, memberships, activeAccountId);
  // No account to attach to; back to setup, where /connect creates one.
  if (!membership) return bounceTo("/connect?error=no_code");

  // THE SAME PREDICATE `addAccount` USES, which is the DEFECT 4 fix (356
  // binding 2). This lookup was scoped `inArray(accountId, memberships)`, so it
  // could only ever see the caller's own accounts: a Stripe account live on a
  // stranger's Foxhound account read as unattached here and a second live row
  // was written. Legacy's upsert is keyed on `stripe_user_id` alone and would
  // MOVE the connection; Foxhound refuses instead, and now refuses in both
  // directions rather than only within one merchant.
  const attachment = await findLiveAttachment(
    db,
    oauth.stripeUserId,
    memberships.map((m) => m.accountId),
  );
  const heldOnAnother =
    attachment.status === "held_elsewhere" ||
    (attachment.status === "held_by_caller" && attachment.accountId !== membership.accountId);
  if (heldOnAnother) {
    // ONE ERROR PARAM FOR BOTH CASES, deliberately. Held by a stranger is a
    // tenancy question and held by this merchant's own second account is not,
    // but the response must not distinguish them: a caller who controls the
    // Stripe account could otherwise learn whether it sits on somebody else's
    // ledger. Moving it would be worse than refusing either way, since it
    // re-points every future webhook for that Stripe account and silently
    // re-attributes the recoveries it produces.
    return bounceTo("/connect?error=stripe_account_already_connected");
  }

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

  const encryptedToken = await encryptToken(env, oauth.accessToken);
  const accountName = await fetchConnectedAccountName(env, oauth.stripeUserId);
  const now = new Date();
  // Set only when a row is inserted: the welcome page is for a new connection.
  const insertId = crypto.randomUUID();
  const newConnectionId = existing.length > 0 ? null : insertId;

  // Reconnect vs first connect: if this Stripe account is already attached to
  // this Foxhound account, refresh its token; otherwise insert. The read is safe
  // under the per-account DO serialization (no concurrent writer for this
  // account). Connect is not fee-bearing, so a fresh idempotency key per
  // callback lets a genuine reconnect update the token.
  await executeMoneyWrite(env, {
    accountId: membership.accountId,
    idempotencyKey: `connect:${membership.accountId}:${oauth.stripeUserId}:${now.getTime()}`,
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
              id: insertId,
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

  return redirect(destinationFor(newConnectionId), {
    headers: { "Set-Cookie": clearStateCookie() },
  });
}

function bounceTo(path: string): Response {
  return redirect(path, { headers: { "Set-Cookie": clearStateCookie() } });
}
