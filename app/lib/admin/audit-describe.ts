// The audit log in plain English (Dustin's review, 2026-10-11): what each
// action did, as a short past-tense sentence, and what it was done to, as a
// real target with a link where the admin has a page for it. Pure, so the
// wording is tested without a database; the page's loader supplies the names it
// looks up (merchant names, post titles).

import { merchantHref } from "~/lib/admin/page";
import { plural } from "~/lib/admin/overview";
import { formatMoney } from "~/lib/money-format";

const ACTIONS: Record<string, string> = {
  "cron.enable": "Turned on a cron",
  "cron.disable": "Disabled a cron",
  "brake.engage": "Engaged the emergency brake",
  "brake.release": "Released the emergency brake",
  "brake.pause.account": "Paused a merchant (emergency brake)",
  "brake.resume.account": "Resumed a merchant (emergency brake)",
  "merchant.processing.pause": "Paused a merchant's processing",
  "merchant.processing.resume": "Resumed a merchant's processing",
  "merchant.billing_exempt.enable": "Made a merchant billing exempt",
  "merchant.billing_exempt.disable": "Ended a merchant's billing exemption",
  "merchant.intelligence.grant": "Granted a merchant Intelligence",
  "merchant.intelligence.revoke": "Revoked a merchant's Intelligence",
  "merchant.cancel": "Canceled a merchant",
  "billing.adjustment.create": "Added a billing adjustment",
  "blog.create": "Created a blog post",
  "blog.update": "Edited a blog post",
  "blog.publish": "Published a blog post",
  "blog.unpublish": "Unpublished a blog post",
  "blog.set-links": "Changed a blog post's related links",
  "staged.create": "Staged a change for approval",
  "staged.confirm": "Approved and applied a staged change",
  "staged.reject": "Rejected a staged change",
  "staged.failed": "A staged change failed to apply",
  // Written outside the admin pages. Recova labeled the first "Account deleted
  // (self)" (app/admin/platform/audit-log/page.tsx, blob 5003157c).
  user_self_deleted_account: "Deleted their own account",
  user_self_deleted_account_deauthorize_failed: "Could not revoke a deleted account's Stripe connection",
  "email.test_send": "Sent a test email",
};

// Recova's own codes (app/admin/platform/audit-log/page.tsx, blob 5003157c,
// ACTION_LABELS). admin_audit_log is carried from Recova
// (docs/schema/legacy-map.md), so its rows appear here; Foxhound writes none.
const CARRIED: Record<string, string> = {
  trigger_cron: "Triggered a cron",
  view_user_list: "Viewed the user list",
  view_cron_health: "Viewed cron health",
  impersonation_start: "Started impersonating a user",
  impersonation_stop: "Stopped impersonating a user",
  billing_exempt_toggle: "Toggled a merchant's billing exemption",
  processing_paused_toggle: "Toggled a merchant's processing pause",
};

/** The action as a sentence. An action this list does not know yet is shown
 *  as written, so a new one is never hidden. */
export function describeAuditAction(action: string): string {
  return ACTIONS[action] ?? CARRIED[action] ?? action;
}

export interface AuditTarget {
  label: string;
  href?: string;
}

export interface AuditEntryLike {
  action: string;
  targetEmail: string | null;
  targetUserId: string | null;
  metadata: unknown;
}

export interface AuditLookups {
  merchantNames: ReadonlyMap<string, string | null>;
  postTitles: ReadonlyMap<string, string>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The ids the loader looks up names for. */
export function auditLookupIds(entries: ReadonlyArray<AuditEntryLike>): { accountIds: string[]; postIds: string[] } {
  const accountIds = new Set<string>();
  const postIds = new Set<string>();
  for (const e of entries) {
    const m = record(e.metadata);
    const accountId = str(m.accountId);
    if (accountId) accountIds.add(accountId);
    const postId = str(m.postId);
    if (postId) postIds.add(postId);
  }
  return { accountIds: [...accountIds], postIds: [...postIds] };
}

/**
 * What the action was done to, or null when it has no single target. Never
 * raw JSON: a merchant by name, a cron by name, a post by title, a staged
 * change by its own summary, the brake by how many merchants it covered.
 */
export function auditTarget(entry: AuditEntryLike, lookups: AuditLookups): AuditTarget | null {
  const m = record(entry.metadata);

  const accountId = str(m.accountId);
  if (accountId) {
    const name = lookups.merchantNames.get(accountId);
    return { label: name ?? accountId, href: merchantHref(accountId) };
  }

  const cronName = str(m.cronName);
  if (cronName) return { label: cronName, href: `/admin/platform/crons#cron-${cronName}` };

  const postId = str(m.postId);
  if (postId) {
    const title = lookups.postTitles.get(postId) ?? str(m.title) ?? str(m.slug) ?? postId;
    // No link: the /admin/blog editor is gone and posts are edited in Carrel
    // (RULES.md 7.4), so a post entry names its title only.
    return { label: title };
  }

  if (entry.action.startsWith("staged.")) {
    const summary = str(m.summary);
    return { label: summary ?? "A staged change", href: "/admin/staged" };
  }

  if (entry.action === "brake.engage" || entry.action === "brake.release") {
    const count = typeof m.intendedCount === "number" ? m.intendedCount : null;
    const label = count === null ? "All merchants" : `All merchants (${count})`;
    return { label, href: "/admin/brake" };
  }

  const email = entry.targetEmail ?? null;
  if (email) return { label: email };
  if (entry.targetUserId) return { label: entry.targetUserId };
  return null;
}

/** The actor in words: an operator by email, and the merchant who deleted
 *  their own account (written as "account-owner") as the account owner. */
export function auditActor(actorEmail: string): string {
  return actorEmail === "account-owner" ? "The account owner" : actorEmail;
}

const VIA: Record<string, string> = {
  "admin-api": "the admin API",
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An amount with its currency; a code Intl refuses is shown beside the
 *  figure, which formatMoney now does itself. */
function money(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}

/**
 * Recova's Detail column (app/admin/platform/audit-log/page.tsx, blob 5003157c)
 * in plain words: the one fact the action and its target do not already say,
 * or null when there is none. An action this list does not know shows its first
 * plain key and value, as Recova's did, and never JSON.
 */
export function auditDetail(entry: AuditEntryLike): string | null {
  const m = record(entry.metadata);
  const via = str(m.via);

  switch (entry.action) {
    case "cron.enable":
    case "cron.disable":
      return via === "brake-panel" ? "From the emergency brake page" : null;
    case "merchant.processing.pause":
    case "merchant.processing.resume":
      return via && VIA[via] ? `Through ${VIA[via]}` : null;
    case "staged.create":
      return via && VIA[via] ? `Requested through ${VIA[via]}` : null;
    case "staged.confirm": {
      const by = str(m.requestedBy);
      return by ? `Requested by ${by}` : null;
    }
    case "staged.failed":
    case "user_self_deleted_account_deauthorize_failed": {
      // Cut like the fallback, so a long stack or provider message never
      // floods the table (review of #94).
      const error = str(m.error);
      return error === null ? null : cut(error);
    }
    case "merchant.cancel": {
      const disconnected = count(m.connectionsDisconnected);
      const failed = Array.isArray(m.deauthorizeErrors) ? m.deauthorizeErrors.length : 0;
      const parts: string[] = [];
      if (disconnected !== null) {
        parts.push(`${plural(disconnected, "Stripe connection", "Stripe connections")} disconnected`);
      }
      if (failed > 0) parts.push(`${failed} could not be revoked`);
      return parts.length > 0 ? parts.join(", ") : null;
    }
    case "merchant.intelligence.grant":
      return m.granted === false ? "Already had Intelligence, nothing changed" : null;
    case "merchant.intelligence.revoke":
      return m.revoked === false ? "Had no granted Intelligence, nothing changed" : null;
    case "billing.adjustment.create": {
      const cents = count(m.amountCents);
      if (cents === null) return null;
      const amount = money(cents, str(m.currency) ?? "usd");
      const description = str(m.description);
      return description ? `${amount}: ${description}` : amount;
    }
    case "blog.set-links":
      return Array.isArray(m.targetIds) ? plural(m.targetIds.length, "related link", "related links") : null;
    case "email.test_send": {
      const type = str(m.type);
      if (!type) return null;
      return entry.targetEmail ? `${type}, sent to ${entry.targetEmail}` : type;
    }
    // Recova's two detail cases (metaDetail); its other codes take the fallback below.
    case "trigger_cron":
      return str(m.cron_path) ?? fallbackDetail(m);
    case "view_user_list": {
      const users = count(m.user_count);
      return users === null ? fallbackDetail(m) : plural(users, "user", "users");
    }
    case "user_self_deleted_account": {
      const parts: string[] = [];
      if (Array.isArray(m.account_ids)) {
        parts.push(`${plural(m.account_ids.length, "merchant account", "merchant accounts")} deleted`);
      }
      const disconnected = count(m.stripe_connections_disconnected);
      if (disconnected !== null) {
        parts.push(`${plural(disconnected, "Stripe connection", "Stripe connections")} disconnected`);
      }
      const kept = count(m.kept_recovered_payments);
      if (kept !== null) parts.push(`${plural(kept, "recovered payment", "recovered payments")} kept`);
      return parts.length > 0 ? parts.join(", ") : null;
    }
  }

  if (ACTIONS[entry.action]) return null;
  return fallbackDetail(m);
}

// Keys whose values are never shown: a credential, an address or a Stripe user.
const UNSHOWN_KEY = /token|secret|key|password|stripe_user_id|email|recipient/i;
const FALLBACK_MAX = 80;

/** A shown value cut at FALLBACK_MAX characters with an ellipsis. */
function cut(text: string): string {
  return text.length > FALLBACK_MAX ? `${text.slice(0, FALLBACK_MAX)}…` : text;
}

/** Recova's fallback (first key and value) for a code with no case of its own,
 *  limited to plain values under keys that cannot hold a secret, and cut short. */
function fallbackDetail(m: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(m)) {
    if (UNSHOWN_KEY.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return `${key}: ${cut(String(value))}`;
    }
  }
  return null;
}
