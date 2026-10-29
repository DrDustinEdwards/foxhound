import { inArray } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts } from "~/db";
import type { Membership } from "~/lib/auth/account";

import {
  DEMO_ACTIVE_ACCOUNT_COOKIE,
  DEMO_BUSINESSES,
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_COOKIE_VALUE,
  type DemoBusiness,
} from "./constants";

// Read-only demo view mode. A visitor who enters the demo gets a cookie that the
// app-shell middleware recognizes; with it (and NO real session) it injects a
// synthetic membership for the demo account so the REAL app routes render demo
// data. The cookie carries no account id, so it can only ever resolve to a
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

// Legacy kept `active_demo_account` for a year (switch-account/route.ts), so a
// returning visitor lands on the business they last looked at.
const DEMO_ACTIVE_ACCOUNT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The demo business with this account id, or null for anything else. The one
 *  check both the switch route and the cookie reader use: only an id in
 *  DEMO_BUSINESSES is ever honored, so neither can name a real account. */
export function findDemoBusiness(accountId: string | null | undefined): DemoBusiness | null {
  return DEMO_BUSINESSES.find((b) => b.accountId === accountId) ?? null;
}

/** The demo business the visitor last switched to, else the first (Teamflow),
 *  as legacy's SiteNav.tsx read `active_demo_account || demoList[0].id`. */
export function activeDemoBusiness(request: Request): DemoBusiness {
  return findDemoBusiness(readCookie(request, DEMO_ACTIVE_ACCOUNT_COOKIE)) ?? DEMO_BUSINESSES[0];
}

export function setActiveDemoAccountCookieHeader(business: DemoBusiness): string {
  return `${DEMO_ACTIVE_ACCOUNT_COOKIE}=${business.accountId}; Path=/; Max-Age=${DEMO_ACTIVE_ACCOUNT_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Where a demo-related redirect should land depending on whether the caller
 * also has a real session (TASK-foxhound-demo-access-parity.md's
 * demo-over-session precedence means a signed-in caller can be viewing the
 * demo). Shared by the app-shell guard's not-yet-seeded fallback and
 * /demo/exit, so the two can never drift on this decision.
 */
export function demoFallbackPath(hasSession: boolean): string {
  return hasSession ? "/console" : "/demos";
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
 * The one copy of the message a demo visitor sees when a control they clicked
 * would have mutated something (TASK-foxhound-demo-system-completion.md
 * Phase 1). appShellMiddleware throws this as the body of its 405, and
 * app/root.tsx's ErrorBoundary reads it back off the thrown response so the
 * rejection reads as a normal product message instead of a raw framework
 * error page.
 */
export const DEMO_READ_ONLY_MESSAGE =
  "Actions are disabled in this demo. Explore freely; nothing here can be changed.";

function demoMembership(business: DemoBusiness, accountName: string | null): Membership {
  return {
    memberId: `${business.accountId}_member`,
    accountId: business.accountId,
    accountName,
    role: "owner",
  };
}

/**
 * The synthetic memberships for every seeded demo business, in DEMO_BUSINESSES
 * order: what the account switcher lists in the demo. Read-only: never creates
 * anything. Empty before the demo is seeded.
 */
export async function resolveDemoMemberships(db: Db): Promise<Membership[]> {
  const rows = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(inArray(accounts.id, DEMO_BUSINESSES.map((b) => b.accountId)));
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  return DEMO_BUSINESSES.filter((b) => nameById.has(b.accountId)).map((b) =>
    demoMembership(b, nameById.get(b.accountId) ?? null),
  );
}

/**
 * Resolve the synthetic membership for a demo business (Teamflow unless one is
 * named), or null if it has not been seeded yet (so the caller can send the
 * visitor back to /demos instead of into an empty shell).
 */
export async function resolveDemoMembership(
  db: Db,
  business: DemoBusiness = DEMO_BUSINESSES[0],
): Promise<Membership | null> {
  const all = await resolveDemoMemberships(db);
  return all.find((m) => m.accountId === business.accountId) ?? null;
}
