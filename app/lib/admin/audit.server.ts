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

/** The insert statement plus the id it will carry, WITHOUT executing it, so a
 *  caller batching many audit rows can put them in one db.batch instead of one
 *  round trip each (the global brake pauses every account at once). Same row
 *  shape as logAdminAction, which is written in terms of this. */
export function buildAdminAuditLogInsert(db: Db, input: LogAdminActionInput) {
  const id = crypto.randomUUID();
  return {
    id,
    statement: db.insert(adminAuditLog).values({
      id,
      actorEmail: input.actorEmail,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      targetEmail: input.targetEmail ?? null,
      metadata: input.metadata ?? null,
      createdAt: new Date(),
    }),
  };
}

/** Inserts the audit row and returns its id (admin Pass 2: an adjustment line
 *  item FKs this id, so a caller that needs the reference reads it off the
 *  return value rather than re-querying). */
export async function logAdminAction(db: Db, input: LogAdminActionInput): Promise<string> {
  const { id, statement } = buildAdminAuditLogInsert(db, input);
  await statement;
  return id;
}
