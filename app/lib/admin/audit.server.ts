// Operator audit trail (SCHEMA.md admin_audit_log: global, permanent retention).
// Every admin action that changes runtime behavior writes one row here so
// /admin/audit-log has something real to show. Not a money write (no DO): this
// table is operational, mirroring the recovery_steps / cron_run_history
// precedent (app/lib/cron/run.ts) of plain inserts for non-money operator/system
// actions.

import type { Db } from "~/db";
import { adminAuditLog } from "~/db";

export interface LogAdminActionInput {
  actorEmail: string;
  action: string;
  targetUserId?: string | null;
  targetEmail?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function logAdminAction(db: Db, input: LogAdminActionInput): Promise<void> {
  await db.insert(adminAuditLog).values({
    id: crypto.randomUUID(),
    actorEmail: input.actorEmail,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetEmail: input.targetEmail ?? null,
    metadata: input.metadata ?? null,
    createdAt: new Date(),
  });
}
