import { and, eq, isNull } from "drizzle-orm";

import { getDb, stripeConnections } from "~/db";

import { resolveActiveMembership } from "./account";
import { DEFAULT_NEXT_PATH } from "./next-path";
import type { getSession } from "./session";

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
  const membership = await resolveActiveMembership(db, session.user.id, session.session.activeAccountId ?? null);
  if (!membership) return "/connect";
  const live = await db
    .select({ id: stripeConnections.id })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.accountId, membership.accountId), isNull(stripeConnections.disconnectedAt)))
    .limit(1);
  return live.length > 0 ? next : "/connect";
}
