// The audit log in plain English (Dustin's review, 2026-10-11): what each
// action did, as a short past-tense sentence, and what it was done to, as a
// real target with a link where the admin has a page for it. Pure, so the
// wording is tested without a database; the page's loader supplies the names it
// looks up (merchant names, post titles).

import { merchantHref } from "~/lib/admin/page";

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
  "merchant.cancel": "Cancelled a merchant",
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
};

/** The action as a sentence. An action this list does not know yet is shown
 *  as written, so a new one is never hidden. */
export function describeAuditAction(action: string): string {
  return ACTIONS[action] ?? action;
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
  if (cronName) return { label: cronName, href: `/admin/crons#cron-${cronName}` };

  const postId = str(m.postId);
  if (postId) {
    const title = lookups.postTitles.get(postId) ?? str(m.title) ?? str(m.slug) ?? postId;
    return { label: title, href: `/admin/blog/${encodeURIComponent(postId)}` };
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
