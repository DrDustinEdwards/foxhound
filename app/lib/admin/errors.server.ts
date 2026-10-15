// /admin/platform/errors data layer (J48). READ only.
//
// Two sources, each read only when something writes to it (RULES.md 3.18):
//
// 1. Sentry. The Worker sends to Sentry only while SENTRY_DSN is set
//    (workers/app.ts). The DSN cannot read anything back: listing issues needs
//    a Sentry auth token (event:read) and the organisation's slug, so the page
//    reads Sentry only when all three are set, and otherwise says which are
//    missing. The token goes in the Authorization header to the sentry.io API
//    for the DSN's own region and nowhere else; it is never returned, rendered
//    or logged.
// 2. Recova's list: audit log entries whose action names an error or a
//    failure (app/admin/platform/errors/page.tsx, blob 9cca8956, the last 50).
//    Foxhound writes such entries: staged.failed (app/lib/admin/staged.server.ts)
//    and the account deletion's deauthorize failure
//    (app/lib/auth/delete-account.server.ts).

import { desc, like, or } from "drizzle-orm";

import type { Db } from "~/db";
import { adminAuditLog } from "~/db";

/** How many unresolved issues the page asks Sentry for. */
export const SENTRY_ISSUE_LIMIT = 25;
/** Sentry's own window for "seen recently" on the issues list. */
export const SENTRY_STATS_PERIOD = "14d";
/** Recova's page showed the last 50 matching entries. */
export const FAILED_ACTION_LIMIT = 50;
const SENTRY_TIMEOUT_MS = 5000;

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  level: string;
  count: number;
  userCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  permalink: string | null;
}

export type SentryState =
  | { state: "not-connected" }
  | { state: "no-reader"; missing: string[] }
  | { state: "unreadable-dsn" }
  | { state: "failed"; message: string }
  | { state: "ready"; issues: SentryIssue[] };

// o<org id>.ingest[.<region>].sentry.io, exactly; anything else is not
// Sentry's hosted service and is never sent the token.
const INGEST_HOST = /^o\d+\.ingest\.(?:([a-z]{2})\.)?sentry\.io$/;

/** The sentry.io API base for a DSN's region and its numeric project id, or
 *  null when the DSN is not a hosted sentry.io one this page can read. */
export function sentryApiBase(dsn: string): { apiBase: string; projectId: string } | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const match = INGEST_HOST.exec(url.hostname);
  if (!match) return null;
  const projectId = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^\d+$/.test(projectId)) return null;
  const region = match[1];
  return { apiBase: region ? `https://${region}.sentry.io` : "https://sentry.io", projectId };
}

/** Sentry's own https page for an issue, or null for anything else, so the
 *  page never renders a link Sentry's answer could point anywhere. */
function safePermalink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io") ? url.toString() : null;
  } catch {
    return null;
  }
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function toIssue(raw: Record<string, unknown>): SentryIssue {
  return {
    id: String(raw.id ?? ""),
    shortId: String(raw.shortId ?? raw.id ?? ""),
    title: typeof raw.title === "string" && raw.title ? raw.title : "Untitled error",
    culprit: typeof raw.culprit === "string" && raw.culprit ? raw.culprit : null,
    level: typeof raw.level === "string" ? raw.level : "error",
    count: toCount(raw.count),
    userCount: toCount(raw.userCount),
    firstSeen: toDate(raw.firstSeen),
    lastSeen: toDate(raw.lastSeen),
    permalink: safePermalink(raw.permalink),
  };
}

function failureMessage(status: number, org: string): string {
  if (status === 401 || status === 403) {
    return `Sentry refused the token (${status}). It needs the event:read scope on this organisation.`;
  }
  if (status === 404) return `Sentry found no organisation named ${org}, or no project with this DSN's id in it.`;
  if (status === 429) return "Sentry asked Foxhound to slow down (429). Read again in a minute.";
  return `Sentry answered ${status}.`;
}

/** Whether Sentry can be read, and if so its unresolved issues. */
export async function readSentry(env: Env): Promise<SentryState> {
  if (!env.SENTRY_DSN) return { state: "not-connected" };
  const missing = (["SENTRY_AUTH_TOKEN", "SENTRY_ORG"] as const).filter((name) => !env[name]);
  if (missing.length > 0) return { state: "no-reader", missing };
  const target = sentryApiBase(env.SENTRY_DSN);
  if (!target) return { state: "unreadable-dsn" };

  const org = env.SENTRY_ORG as string;
  const url = new URL(`/api/0/organizations/${encodeURIComponent(org)}/issues/`, target.apiBase);
  url.searchParams.set("project", target.projectId);
  url.searchParams.set("query", "is:unresolved");
  url.searchParams.set("sort", "date");
  url.searchParams.set("statsPeriod", SENTRY_STATS_PERIOD);
  url.searchParams.set("limit", String(SENTRY_ISSUE_LIMIT));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${env.SENTRY_AUTH_TOKEN}`, Accept: "application/json" },
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    });
  } catch {
    return { state: "failed", message: "Sentry did not answer. Read again in a minute." };
  }
  if (!response.ok) return { state: "failed", message: failureMessage(response.status, org) };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: "failed", message: "Sentry's answer was not a list of issues." };
  }
  if (!Array.isArray(body)) return { state: "failed", message: "Sentry's answer was not a list of issues." };
  const issues = body
    .filter((raw): raw is Record<string, unknown> => typeof raw === "object" && raw !== null)
    .map(toIssue);
  return { state: "ready", issues };
}

/** Recova's list: the newest audit entries whose action names an error or a
 *  failure. SQLite's LIKE ignores ASCII case, as Recova's ilike did. */
export async function listFailedAuditEntries(db: Db, limit = FAILED_ACTION_LIMIT) {
  return db
    .select()
    .from(adminAuditLog)
    .where(or(like(adminAuditLog.action, "%error%"), like(adminAuditLog.action, "%fail%")))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit);
}
