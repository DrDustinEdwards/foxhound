// /admin/audit-log data layer: the operator audit trail (admin_audit_log,
// global, permanent retention). READ only.

import { desc } from "drizzle-orm";

import type { Db } from "~/db";
import { adminAuditLog } from "~/db";

export async function listAuditLog(db: Db, limit = 200) {
  return db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(limit);
}
