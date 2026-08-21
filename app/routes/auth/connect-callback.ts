import { and, eq, inArray } from "drizzle-orm";
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
import { ADD_ACCOUNT_ACTION, verifyConnectState } from "~/lib/stripe/connect-state";
import { encryptToken } from "~/lib/stripe/encryption";
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
  // HttpOnly cookie) and must name one of the two known actions. See
  // verifyConnectState for why the comparison is on raw strings.
  const action = verifyConnectState(state, readStateCookie(request));
  if (!action) return bounce("invalid_state");

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

/** Where a merchant lands once a connection is live on `accountId`. */
async function destinationFor(db: Db, accountId: string): Promise<string> {
  const [row] = await db
    .select({ onboardingCompleted: accounts.onboardingCompleted })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.onboardingCompleted ? "/dashboard" : "/welcome";
}

/** Land on `accountId` with this session pointed at it. */
async function landOn(
  db: Db,
  sessionId: string,
  accountId: string,
): Promise<Response> {
  await setSessionActiveAccount(db, sessionId, accountId);
  return redirect(await destinationFor(db, accountId), {
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
  const heldAccountIds = memberships.map((m) => m.accountId);

  // Is this Stripe account already attached somewhere? Asked BEFORE anything is
  // written, and answered in two halves because the two answers are different
  // kinds of thing.
  const attached = await db
    .select({
      accountId: stripeConnections.accountId,
    })
    .from(stripeConnections)
    .where(eq(stripeConnections.stripeUserId, oauth.stripeUserId))
    .limit(1);
  const attachedTo = attached[0]?.accountId ?? null;

  if (attachedTo && heldAccountIds.includes(attachedTo)) {
    // Already theirs. Legacy would upsert and, from the switcher's "+ Add
    // account", mint a duplicate account around a connection that already
    // exists. Take them to the account instead and write nothing: a merchant who
    // re-runs add-account for a Stripe account they already added has asked to
    // go there, not to have a second empty account. Class (c) truthfulness fix.
    return landOn(db, sessionId, attachedTo);
  }

  if (attachedTo) {
    // Attached to an account this user does NOT hold. Refuse, and say only that
    // it is already connected: naming the account, or even confirming which one,
    // would leak another merchant's tenancy to whoever controls the Stripe
    // account. No em dash, no account id, no hint.
    return bounceTo("/connect?error=stripe_account_already_connected");
  }

  const accountId = crypto.randomUUID();
  const encryptedToken = await encryptToken(env, oauth.accessToken);
  const accountName = await fetchConnectedAccountName(env, oauth.stripeUserId);
  const now = new Date();

  await executeMoneyWrite(env, {
    accountId,
    idempotencyKey: `add-account:${accountId}`,
    build: (tx) => [
      tx.insert(accounts).values({ id: accountId, name: accountName, createdAt: now }),
      tx.insert(stripeConnections).values({
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

  return landOn(db, sessionId, accountId);
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

  // This Stripe account may already be attached elsewhere. Legacy's upsert is
  // keyed on `stripe_user_id` alone and would MOVE it; refuse instead, unless it
  // is already on an account this caller holds, which is the reconnect case.
  const elsewhere = await db
    .select({ accountId: stripeConnections.accountId })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.stripeUserId, oauth.stripeUserId),
        inArray(
          stripeConnections.accountId,
          memberships.map((m) => m.accountId),
        ),
      ),
    )
    .limit(1);
  const heldElsewhere = elsewhere[0]?.accountId ?? null;
  if (heldElsewhere && heldElsewhere !== membership.accountId) {
    // The merchant holds BOTH accounts, so this is not a tenancy leak. It is
    // also not a reconnect: moving a live connection between two of their own
    // ledgers would re-point every future webhook for that Stripe account, and
    // silently re-attribute the recoveries it produces. Refuse and say so.
    // Same error param as the not-yours case, deliberately: the two differ in
    // who owns the other account, and the response must not.
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

  return redirect(await destinationFor(db, membership.accountId), {
    headers: { "Set-Cookie": clearStateCookie() },
  });
}

function bounceTo(path: string): Response {
  return redirect(path, { headers: { "Set-Cookie": clearStateCookie() } });
}
