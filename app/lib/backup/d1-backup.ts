import { backupHealth, runCheckedBackup, type BackupHealth, type R2Like } from "@dustinedwards/d1-dump";

import type { CronJobResult } from "~/lib/cron/run";

// Nightly D1 backup (job_f7f35d4b7ac7, Dustin's answers to design-centralize
// DECIDE 1 to 8): a per-table JSON dump into Foxhound's own R2 bucket through
// the shared d1-dump package, on the existing daily cron (no new Cron Trigger).
// D1 Time Travel stays the in-place restore; this is the copy outside it.
//
// ADDS A BACKUP ONLY. It reads D1 and writes R2 and touches no payment or
// recovery path.

/**
 * Tables left OUT of the dump, because they hold live credentials or one-time
 * tokens and a backup copy is one more place a session could leak from (a
 * restore would also revive old sessions):
 *
 *  - session       Better Auth session tokens (live credentials).
 *  - verification  Better Auth one-time tokens: email verification, password reset.
 *  - account       Better Auth credential rows: the password hash AND the Google
 *                  OAuth access, refresh and id tokens. Those provider tokens are
 *                  stored in PLAIN TEXT (no encryptOAuthTokens in
 *                  app/lib/auth/options.ts). FINDING for the seat, not fixed here.
 *                  After a restore, password users reset their password and
 *                  Google users sign in again; user rows are kept.
 *
 * KEPT ON PURPOSE: stripe_connections. Its stripe_access_token is AES-256-GCM
 * encrypted by app code (ENCRYPTION_KEY / ENCRYPTION_KEYS_OLD are Worker secrets,
 * never in D1 or the backup bucket), so the dump alone cannot use it, and a
 * restore without it would break recovery for every merchant. api_keys keeps
 * only SHA-256 hashes. account_members.invite_token (pending invites, expiring)
 * and email_suppressions.token (the unsubscribe token) stay because the tables
 * are business data; d1-dump excludes whole tables only.
 */
export const BACKUP_EXCLUDED_TABLES = ["session", "verification", "account"] as const;

/** Tables that must be in every dump; their absence means the dump is not real. */
const BACKUP_REQUIRED_TABLES = ["accounts", "stripe_connections", "failed_payments"] as const;

function requireBucket(env: Env): R2Like {
  if (!env.BACKUPS) {
    throw new Error(
      "BACKUPS R2 binding is not configured (wrangler.jsonc r2_buckets should bind foxhound-backups)",
    );
  }
  return env.BACKUPS as unknown as R2Like;
}

/**
 * The cron handler body, by d1-dump's runCheckedBackup: dump without the marker, refuse a dump
 * with no tables or no rows, a credential table in it or a required table missing (BackupIncomplete,
 * leaving it without the marker, so a bad run is never the "latest" dump), then mark complete and
 * prune.
 */
export async function runD1Backup(env: Env, now: Date): Promise<CronJobResult> {
  const { dump, pruned } = await runCheckedBackup(env.DB, requireBucket(env), {
    now,
    exclude: [...BACKUP_EXCLUDED_TABLES],
    required: [...BACKUP_REQUIRED_TABLES],
  });
  const rows = dump.tables.reduce((sum, t) => sum + t.rows, 0);
  return {
    rowsProcessed: rows,
    message: `${dump.tables.length} tables, ${rows} rows, ${dump.excluded.length} excluded, pruned ${pruned.pruned}, locked ${pruned.locked}`,
  };
}

/** The unauthenticated health fields: age of the newest complete dump. */
export async function backupStatus(env: Env, now = new Date()): Promise<BackupHealth> {
  if (!env.BACKUPS) {
    return { last_ok: null, age_hours: null, warning: "no backup bucket is bound" } as BackupHealth;
  }
  return backupHealth(env.BACKUPS as unknown as R2Like, { now });
}
