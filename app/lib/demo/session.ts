import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts } from "~/db";
import type { Membership } from "~/lib/auth/account";

import {
  DEMO_ACCOUNT_ID,
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_COOKIE_VALUE,
} from "./constants";

// Read-only demo view mode. A visitor who enters the demo gets a cookie that the
// app-shell middleware recognizes; with it (and NO real session) it injects a
// synthetic membership for the demo account so the REAL app routes render demo
// data. The cookie carries no account id, so it can only ever resolve to the one
// hardcoded demo account, never a real tenant. HttpOnly so page scripts cannot
// read or forge it.

const DEMO_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8; // an 8h look-around is plenty

export function hasDemoCookie(request: Request): boolean {
  const header = request.headers.get("cookie") ?? "";
  return header
    .split(";")
    .some((c) => c.trim() === `${DEMO_SESSION_COOKIE}=${DEMO_SESSION_COOKIE_VALUE}`);
}

export function setDemoCookieHeader(): string {
  return `${DEMO_SESSION_COOKIE}=${DEMO_SESSION_COOKIE_VALUE}; Path=/; Max-Age=${DEMO_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearDemoCookieHeader(): string {
  return `${DEMO_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Where a demo-related redirect should land depending on whether the caller
 * also has a real session (TASK-foxhound-demo-access-parity.md's
 * demo-over-session precedence means a signed-in caller can be viewing the
 * demo). Shared by the app-shell guard's not-yet-seeded fallback and
 * /demo/exit, so the two can never drift on this decision.
 */
export function demoFallbackPath(hasSession: boolean): string {
  return hasSession ? "/dashboard" : "/demos";
}

/**
 * The read-only rule for demo mode, as a pure decision so it is unit-testable:
 * a demo visitor may only issue safe (read) requests. Every mutating action in
 * the app-shell tree is a POST, so blocking non-GET/HEAD makes the ENTIRE demo
 * surface read-only at one choke point (the app-shell middleware), rather than
 * relying on gating each action individually. "Look, don't touch."
 */
export function demoBlocksMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

/**
 * Resolve the synthetic membership for the demo account, or null if the demo
 * account has not been seeded yet (so the caller can send the visitor back to
 * /demos instead of into an empty shell). Read-only: never creates anything.
 */
export async function resolveDemoMembership(db: Db): Promise<Membership | null> {
  const rows = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, DEMO_ACCOUNT_ID))
    .limit(1);
  if (rows.length === 0) return null;
  return {
    memberId: `${DEMO_ACCOUNT_ID}_member`,
    accountId: DEMO_ACCOUNT_ID,
    accountName: rows[0].name,
    role: "owner",
  };
}
