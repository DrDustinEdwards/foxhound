// Admin "View as merchant": Recova's Impersonate (app/admin/AdminClient.tsx,
// its impersonate_email cookie and requireAccount's override), rebuilt
// read-only.
//
// What differs from Recova, and why:
//   - The cookie holds a random token, never an account id or an email
//     (RULES.md 4.6: the account is never chosen by a cookie). The token's
//     SHA-256 keys an admin_impersonations row, which names the admin, the
//     account and when it ends.
//   - It lasts 30 minutes, and is honored only while the admin who started it
//     still passes Cloudflare Access (getAdminSession) on the same request.
//   - It is read-only: appShellMiddleware refuses every non-GET/HEAD with 405
//     while the cookie is present, before any session, membership or database
//     work, the demo firewall's approach (RULES.md 4.12).
//   - Start, Stop and expiry each write admin_audit_log (impersonation_start /
//     impersonation_stop, Recova's codes), naming the admin and the account.

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { accountMembers, accounts, adminImpersonations, user } from "~/db";
import { getAdminSession } from "~/lib/auth/access.server";
import type { Membership } from "~/lib/auth/account";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";

import { buildAdminAuditLogInsert } from "./audit.server";

export const IMPERSONATION_COOKIE = "fh_view_as";
const IMPERSONATION_TTL_MS = 30 * 60 * 1000;
export const IMPERSONATION_STOP_PATH = "/admin/view-as/stop";
export const IMPERSONATION_READ_ONLY_MESSAGE =
  "You are viewing this merchant read-only. Nothing can be changed while viewing as a merchant.";

function readToken(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === IMPERSONATION_COOKIE) {
      const value = rest.join("=");
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Cookie presence only, no database: what the read-only gate keys on. */
export function hasImpersonationCookie(request: Request): boolean {
  return readToken(request) !== null;
}

function setImpersonationCookieHeader(token: string): string {
  return `${IMPERSONATION_COOKIE}=${token}; Path=/; Max-Age=${IMPERSONATION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearImpersonationCookieHeader(): string {
  return `${IMPERSONATION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Opens a 30-minute read-only view of `accountId` for `adminEmail`: the row and
 * its impersonation_start audit row in one batch. Returns the Set-Cookie value,
 * or null when the account does not exist.
 */
export async function startImpersonation(
  db: Db,
  input: { adminEmail: string; accountId: string; now: Date },
): Promise<{ setCookie: string } | null> {
  const [account] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.accountId)).limit(1);
  if (!account) return null;

  const token = newToken();
  const id = crypto.randomUUID();
  const expiresAt = new Date(input.now.getTime() + IMPERSONATION_TTL_MS);
  const audit = buildAdminAuditLogInsert(db, {
    actorEmail: input.adminEmail,
    action: "impersonation_start",
    metadata: { accountId: input.accountId, impersonationId: id, expiresAt: expiresAt.toISOString() },
  });
  await db.batch([
    db.insert(adminImpersonations).values({
      id,
      tokenHash: await hashToken(token),
      adminEmail: input.adminEmail,
      accountId: input.accountId,
      startedAt: input.now,
      expiresAt,
    }),
    audit.statement,
  ]);
  return { setCookie: setImpersonationCookieHeader(token) };
}

/** Ends an open row and logs impersonation_stop, once: the update only matches
 *  a row still open, so a second Stop, or Stop racing expiry, logs nothing. */
async function endImpersonation(
  db: Db,
  row: { id: string; accountId: string },
  actorEmail: string,
  reason: "stopped" | "expired",
  now: Date,
): Promise<boolean> {
  const ended = await db
    .update(adminImpersonations)
    .set({ endedAt: now, endReason: reason })
    .where(and(eq(adminImpersonations.id, row.id), isNull(adminImpersonations.endedAt)))
    .returning({ id: adminImpersonations.id });
  if (ended.length === 0) return false;
  await buildAdminAuditLogInsert(db, {
    actorEmail,
    action: "impersonation_stop",
    metadata: { accountId: row.accountId, impersonationId: row.id, reason },
  }).statement;
  return true;
}

async function findByToken(db: Db, token: string) {
  const [row] = await db
    .select()
    .from(adminImpersonations)
    .where(eq(adminImpersonations.tokenHash, await hashToken(token)))
    .limit(1);
  return row ?? null;
}

/** Stop: ends the request's open row, if any, and returns the account it was
 *  on so the admin lands back on that merchant's page. */
export async function stopImpersonation(
  db: Db,
  request: Request,
  actorEmail: string,
  now: Date,
): Promise<{ accountId: string } | null> {
  const token = readToken(request);
  if (!token) return null;
  const row = await findByToken(db, token);
  if (!row) return null;
  await endImpersonation(db, row, actorEmail, "stopped", now);
  return { accountId: row.accountId };
}

export interface ActiveImpersonation {
  adminEmail: string;
  membership: Membership;
  userId: string;
  userName: string;
  email: string;
}

/**
 * The view this request should render, or null when the cookie is not honored
 * (no row, ended, expired, or the admin no longer passes Access). An expired
 * row is ended and logged here, on the first request that sees it.
 *
 * The merchant is seen as its owner sees it: the earliest active owner's
 * membership (else the earliest active member's), and that person's name.
 */
export async function resolveImpersonation(
  env: Env,
  db: Db,
  request: Request,
  now: Date,
): Promise<ActiveImpersonation | null> {
  const token = readToken(request);
  if (!token) return null;
  const row = await findByToken(db, token);
  if (!row || row.endedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await endImpersonation(db, row, row.adminEmail, "expired", now);
    return null;
  }

  const admin = await getAdminSession(env, request);
  if (!admin || admin.email !== row.adminEmail) return null;

  const [member] = await db
    .select({
      memberId: accountMembers.id,
      accountName: accounts.name,
      role: accountMembers.role,
      userId: accountMembers.userId,
      userName: user.name,
      email: user.email,
    })
    .from(accounts)
    .leftJoin(
      accountMembers,
      and(eq(accountMembers.accountId, accounts.id), eq(accountMembers.status, MEMBER_STATUS.ACTIVE)),
    )
    .leftJoin(user, eq(user.id, accountMembers.userId))
    .where(eq(accounts.id, row.accountId))
    .orderBy(desc(eq(accountMembers.role, MEMBER_ROLE.OWNER)), asc(accountMembers.createdAt))
    .limit(1);
  if (!member) return null;

  return {
    adminEmail: row.adminEmail,
    membership: {
      memberId: member.memberId ?? `${row.accountId}_view_as`,
      accountId: row.accountId,
      accountName: member.accountName,
      role: member.role ?? MEMBER_ROLE.OWNER,
    },
    userId: member.userId ?? `${row.accountId}_view_as`,
    userName: member.userName ?? member.accountName ?? "",
    email: member.email ?? row.adminEmail,
  };
}
