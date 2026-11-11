import { safeNextPath } from "@dustinedwards/site-runtime/sign-in-form";
import { and, eq, isNull } from "drizzle-orm";

import { getDb, stripeConnections } from "~/db";

import { resolveActiveMembership } from "./account";
import type { getSession } from "./session";
import { DEFAULT_NEXT_PATH } from "./sign-in-paths";

/** A sign-in's `next`, checked (site-runtime's safeNextPath): a path on this
 *  site, else /console. The OAuth authorize page's round trip through /login
 *  relies on it keeping every query parameter. */
export function nextPath(raw: unknown): string {
  return safeNextPath(raw, { fallback: DEFAULT_NEXT_PATH });
}

/** Where a sign-in by link, code, Google or Apple lands: the passkey offer,
 *  which goes on to `next` (straight away when site-runtime's
 *  shouldOfferPasskey says no). Absolute on Foxhound's own origin, because
 *  Better Auth's relative-path check refuses a query that carries an encoded
 *  URL, which an OAuth authorize `next` always does. */
export function passkeyOfferURL(env: Env, next: string): string {
  return new URL(
    `/passkey?next=${encodeURIComponent(nextPath(next))}`,
    env.BETTER_AUTH_URL,
  ).toString();
}

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/**
 * Where a signed-in person lands when nothing named a destination: /connect
 * while their active account has no live Stripe connection (or no account
 * yet, which /connect names first), else /console. Recova sent a new signup
 * to /connect "so they wire Stripe next" (app/(auth)/signup/page.tsx, blob
 * 08400b4d); an emailed link signs in and signs up alike, so the account's
 * state decides. An explicit next= (an invite, the OAuth authorize page) is
 * kept as given.
 */
export async function signedInLanding(env: Env, session: Session, next: string): Promise<string> {
  if (next !== DEFAULT_NEXT_PATH) return next;
  const db = getDb(env);
  const membership = await resolveActiveMembership(
    db,
    session.user.id,
    session.session.activeAccountId ?? null,
  );
  if (!membership) return "/connect";
  const live = await db
    .select({ id: stripeConnections.id })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.accountId, membership.accountId),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return live.length > 0 ? next : "/connect";
}
