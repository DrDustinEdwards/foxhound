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
import type { Membership } from "~/lib/auth/account";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { executeMoneyWrite } from "~/lib/money/execute";
import { isConstraintOn } from "~/lib/money/serializer";
import {
  exchangeConnectCode,
  fetchConnectedAccountName,
  isMerchantConnectScope,
  type StripeOAuthResult,
} from "~/lib/stripe/connect";
import { ADD_ACCOUNT_ACTION, AUDIT_ACTION, verifyConnectState } from "~/lib/stripe/connect-state";
import { encryptToken } from "~/lib/stripe/encryption";
import { findLiveAttachment } from "~/lib/stripe/connections.server";
import { clearOAuthStateCookie, readOAuthStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect-callback";
import { errorMessage } from "@dustinedwards/site-runtime/log";

// Stripe Connect OAuth callback; every path writes `stripe_connections` through the money-write DO (token encrypted, never logged).
// Two branches by the state's action: "add_account" mints a new account; "connect" attaches to the ACTIVE account from the session marker (never the earliest membership, which could bolt the Stripe account onto the wrong ledger).
// A Stripe account belonging to a different Foxhound account is refused, not moved.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, ctx } = context.get(cloudflareContext);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const bounce = (reason: string) =>
    redirect(`/connect?error=${reason}`, {
      headers: { "Set-Cookie": clearOAuthStateCookie() },
    });

  if (oauthError) {
    // Stripe's own reason (access_denied, bad redirect_uri). Only these two params: a code is a credential, never logged.
    const description = url.searchParams.get("error_description") ?? "";
    console.warn(
      "connect callback: Stripe returned an error:",
      oauthError.slice(0, 100),
      description.slice(0, 300),
    );
    return bounce("denied");
  }
  if (!code) return bounce("no_code");

  // The trust decision, before the code is exchanged: the state must be one we minted (byte-identical to the HttpOnly cookie), name a known action, and (below) name the signed-in user. See verifyConnectState.
  const minted = verifyConnectState(state, readOAuthStateCookie(request));
  if (!minted) return bounce("invalid_state");
  const { action } = minted;
  // Not the audit's: an audit-flow state is refused before the exchange, so an audit grant never attaches a connection or mints an account. Checked on the payload too, not just the cookie name.
  if (action === AUDIT_ACTION) return bounce("invalid_state");

  const session = await getSession(env, request);
  if (!session) throw redirect("/login");
  // A flow started by one user is never finished by another, even in the same browser within the cookie's TTL (see buildConnectState).
  if (minted.userId !== session.user.id) return bounce("invalid_state");

  const db = getDb(env);
  const memberships = await listMemberships(db, session.user.id);

  // Only an owner attaches a Stripe account to an existing account, checked before the exchange. "add_account" needs none.
  let target: Membership | null = null;
  if (action !== ADD_ACCOUNT_ACTION) {
    target = resolveActiveMembershipFrom(memberships, session.session.activeAccountId ?? null);
    // No account to attach to; back to setup, where /connect creates one.
    if (!target) return bounce("no_code");
    if (target.role !== MEMBER_ROLE.OWNER) return bounce("owner_required");
  }

  // First Intelligence sync so the dashboard has data on the first visit. waitUntil, never fatal: the daily sync covers a miss.
  const syncSoon = (accountId: string) =>
    ctx.waitUntil(
      import("~/lib/intelligence/sync.server")
        .then((m) => m.runIntelligenceSyncForAccount(env, accountId, Date.now()))
        .catch((err) => console.error("first intelligence sync failed:", errorMessage(err))),
    );

  try {
    const oauth = await exchangeConnectCode(env, code);
    // Both merchant flows retry invoices and need the write scope; anything else is refused rather than stored.
    if (!isMerchantConnectScope(oauth.scope)) {
      console.error(
        "connect callback: Stripe granted less than the write scope; refusing the connection",
      );
      return bounce("scope_refused");
    }

    return target
      ? await attachToActiveAccount(env, db, target, memberships, oauth, syncSoon)
      : await addAccount(
          env,
          db,
          session.session.id,
          session.user.id,
          memberships,
          oauth,
          syncSoon,
        );
  } catch (err) {
    // Log only type, code and message, never the object: it can carry request context.
    const e = err as { type?: unknown; code?: unknown; message?: unknown };
    console.error(
      "connect callback failed:",
      String(e?.type ?? ""),
      String(e?.code ?? ""),
      String(e?.message ?? ""),
    );
    return bounce("token_exchange_failed");
  }
}

// findLiveAttachment lives in app/lib/stripe/connections.server.ts so the audit results route can call it without pulling the database and token encryption onto the client graph. Not re-exported: the dot-server guard rejects non-loader route exports.

/** Where a merchant lands: a NEW connection goes to /welcome?connection=<its id>, anything else to /console. */
function destinationFor(newConnectionId: string | null): string {
  return newConnectionId
    ? `/welcome?connection=${encodeURIComponent(newConnectionId)}`
    : "/console";
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
    headers: { "Set-Cookie": clearOAuthStateCookie() },
  });
}

/** Where this Stripe account is live, reported against the accounts the caller holds. */
function findCallerLiveAttachment(
  db: Db,
  oauth: StripeOAuthResult,
  memberships: { accountId: string }[],
) {
  return findLiveAttachment(
    db,
    oauth.stripeUserId,
    memberships.map((m) => m.accountId),
  );
}

/**
 * The `add_account` branch: a new account, its connection, owner membership, and the active-account marker.
 * One `executeMoneyWrite` keyed on the new account id (minted here, as the DO is named by it), in one atomic batch, so an account never exists without an owner or a connection.
 * No billing or products rows: the billing-setup path writes `platform_stripe_customer_id`.
 */
async function addAccount(
  env: Env,
  db: Db,
  sessionId: string,
  userId: string,
  memberships: { accountId: string }[],
  oauth: StripeOAuthResult,
  syncSoon: (accountId: string) => void,
): Promise<Response> {
  // Already live somewhere? Asked before any write, through the predicate both branches share.
  const attachment = await findCallerLiveAttachment(db, oauth, memberships);

  if (attachment.status === "held_by_caller") {
    // Already theirs: go there, write nothing.
    return landOn(db, sessionId, attachment.accountId, null);
  }

  if (attachment.status === "held_elsewhere") {
    // Held by someone else: refuse with no account id or hint, which would leak another merchant's tenancy.
    return bounceTo("/connect?error=stripe_account_already_connected");
  }

  const accountId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const encryptedToken = await encryptToken(env, oauth.accessToken);
  const accountName = await fetchConnectedAccountName(env, oauth.stripeUserId);
  const now = new Date();

  const { applied } = await writeConnection(env, {
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
  // Only a landed write moves the session; a refusal means the account was never created.
  if (!applied) return bounceTo("/connect?error=stripe_account_already_connected");

  syncSoon(accountId);
  return landOn(db, sessionId, accountId, connectionId);
}

/** The default branch: attach or reconnect on the caller's ACTIVE account (`resolveActiveMembershipFrom`, which checks ownership), never the earliest. */
async function attachToActiveAccount(
  env: Env,
  db: Db,
  membership: Membership,
  memberships: Membership[],
  oauth: StripeOAuthResult,
  syncSoon: (accountId: string) => void,
): Promise<Response> {
  // The same predicate `addAccount` uses: a lookup scoped to the caller's accounts would miss a stranger's live row and write a second.
  const attachment = await findCallerLiveAttachment(db, oauth, memberships);
  const heldOnAnother =
    attachment.status === "held_elsewhere" ||
    (attachment.status === "held_by_caller" && attachment.accountId !== membership.accountId);
  if (heldOnAnother) {
    // One error param for both cases, deliberately: distinguishing them would tell the caller whether it sits on somebody else's ledger. Moving it would re-point every future webhook.
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

  // Already attached here: refresh the token; otherwise insert. Safe under DO serialization. Not fee-bearing, so a fresh idempotency key per callback is fine.
  const { applied } = await writeConnection(env, {
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
  if (!applied) return bounceTo("/connect?error=stripe_account_already_connected");

  syncSoon(membership.accountId);
  return redirect(destinationFor(newConnectionId), {
    headers: { "Set-Cookie": clearOAuthStateCookie() },
  });
}

/** The connection write; a unique-index refusal (Stripe account went live elsewhere after findLiveAttachment) is reported as not applied; any other failure throws. */
async function writeConnection(
  env: Env,
  write: Parameters<typeof executeMoneyWrite>[1],
): Promise<{ applied: boolean }> {
  try {
    return await executeMoneyWrite(env, write);
  } catch (err) {
    if (isConstraintOn(err, "stripe_connections.stripe_user_id")) return { applied: false };
    throw err;
  }
}

function bounceTo(path: string): Response {
  return redirect(path, { headers: { "Set-Cookie": clearOAuthStateCookie() } });
}
