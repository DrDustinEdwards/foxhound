// /admin/platform/audit-log data layer: the operator audit trail (admin_audit_log,
// global, permanent retention). READ only.

import { desc, inArray } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, adminAuditLog, blogPosts } from "~/db";

import { auditLookupIds, type AuditLookups } from "./audit-describe";

export async function listAuditLog(db: Db, limit = 200) {
  return db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(limit);
}

/** The merchant names and post titles the log's targets name, in two queries
 *  for the whole page rather than one per row. */
export async function loadAuditLookups(
  db: Db,
  entries: Parameters<typeof auditLookupIds>[0],
): Promise<AuditLookups> {
  const { accountIds, postIds } = auditLookupIds(entries);
  const [merchantRows, postRows] = await Promise.all([
    accountIds.length > 0
      ? db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(inArray(accounts.id, accountIds))
      : Promise.resolve([]),
    postIds.length > 0
      ? db.select({ id: blogPosts.id, title: blogPosts.title }).from(blogPosts).where(inArray(blogPosts.id, postIds))
      : Promise.resolve([]),
  ]);
  return {
    merchantNames: new Map(merchantRows.map((r) => [r.id, r.name])),
    postTitles: new Map(postRows.map((r) => [r.id, r.title])),
  };
}
