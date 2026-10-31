import { backupFiles, backupHealth, filesHealth, runCheckedBackup, type BackupHealth, type R2Like } from "@dustinedwards/d1-dump";

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
 *  - preview_links Carrel's preview links (site-api's store): the hash of each
 *                  link's token. A restore would bring back a link revoked
 *                  since; a lost link is made again in Carrel.
 *  - oauth_authorization_codes  single-use MCP authorization codes (code_hash),
 *                  minutes long; none is worth restoring.
 *  - oauth_grants  each MCP connection's refresh token hash. A restore would
 *                  revive a grant revoked since; after one, a client connects
 *                  again.
 *
 * d1-dump's credential-column check is on, so a new column named for a token,
 * secret, password or key hash fails the night until it is excluded or listed
 * in BACKUP_CREDENTIAL_ALLOW with the reason it is safe.
 *
 * KEPT ON PURPOSE (each in BACKUP_CREDENTIAL_ALLOW): stripe_connections. Its stripe_access_token is AES-256-GCM
 * encrypted by app code (ENCRYPTION_KEY / ENCRYPTION_KEYS_OLD are Worker secrets,
 * never in D1 or the backup bucket), so the dump alone cannot use it, and a
 * restore without it would break recovery for every merchant. api_keys keeps
 * only SHA-256 hashes. account_members.invite_token (pending invites, expiring)
 * and email_suppressions.token (the unsubscribe token) stay because the tables
 * are business data.
 *
 * NOT BACKED UP, and why (B6, B7):
 *  - EVIDENCE (foxhound-dispute-evidence): merchants' dispute files, out of this
 *    pass by Dustin's note (area 8's scope).
 *  - The Durable Objects: MONEY_WRITER serializes writes whose rows live in D1
 *    (its own storage holds no money state); CRON_LOCK holds leases and
 *    CRON_TICKER an alarm, both rebuilt on the next tick; RATE_LIMITER and
 *    AUTH_RATE_LIMITER hold counters that expire in minutes.
 *  - BACKUPS is the copy itself. There is no KV namespace bound.
 */
const BACKUP_EXCLUDED_TABLES = [
  "session",
  "verification",
  "account",
  "preview_links",
  "oauth_authorization_codes",
  "oauth_grants",
] as const;

/** Columns whose names read as credentials but are safe in a dump, each with the reason. */
const BACKUP_CREDENTIAL_ALLOW: Record<string, string> = {
  "stripe_connections.stripe_access_token": "AES-256-GCM ciphertext; the keys are Worker secrets",
  "account_members.invite_token": "a pending invite, expiring; the table is membership data",
  "email_suppressions.token": "the unsubscribe link's token; it only unsubscribes",
  "admin_impersonations.token_hash": "SHA-256 of a view-as session that expires in hours; the row is the audit of who viewed which merchant",
  "passkey.credential_id": "a passkey's public credential id",
  "ai_calls.prompt_tokens": "a count",
  "ai_calls.completion_tokens": "a count",
  "ai_calls_monthly.prompt_tokens": "a count",
  "ai_calls_monthly.completion_tokens": "a count",
  "mcp_writes.api_key_id": "a row id, not a key",
  "mcp_calls.api_key_id": "a row id, not a key",
  "admin_api_calls.api_key_id": "a row id, not a key",
};

/**
 * Tables that must be in every dump, because what they hold exists nowhere else: the people and their sign-ins'
 * owners, each merchant's account and Stripe connection, the money records (failed payments, recovery steps,
 * recoveries, outcomes, Foxhound's own invoices and exemptions), disputes, the unsubscribe list (a send to an
 * address on it breaks the law), the admin audit trail and the blog. A missing one means the dump is not real.
 */
const BACKUP_REQUIRED_TABLES = [
  "user",
  "passkey",
  "accounts",
  "account_members",
  "api_keys",
  "stripe_connections",
  "failed_payments",
  "recovery_steps",
  "recovered_payments",
  "outcomes",
  "billing_invoices",
  "billing_line_items",
  "billing_exemption_periods",
  "disputes",
  "dispute_evidence",
  "email_suppressions",
  "admin_audit_log",
  "blog_posts",
  "blog_slug_redirects",
  "media",
  "media_revisions",
  "cron_config",
] as const;

/**
 * Tables counted again straight after the dump, whose dumped rows must equal the live count (required too). Only
 * tables the operator alone writes, so nothing between the dump and the count can change them: the blog and its
 * media library (Carrel), the cron switches and billing exemptions (the admin). Merchant, Stripe-webhook and cron
 * tables are left out on purpose, since a payment event at 03:00 would fail the night. The blog is never empty, so
 * an emptied database cannot pass by matching its own counts.
 */
const BACKUP_COUNTED_TABLES = ["blog_posts", "blog_slug_redirects", "media", "media_revisions", "cron_config", "billing_exemption_periods"] as const;

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
 * with no tables or no rows, a credential table in it, a required table missing or a counted table whose rows differ
 * from its live count (BackupIncomplete,
 * leaving it without the marker, so a bad run is never the "latest" dump), then mark complete and
 * prune.
 */
export async function runD1Backup(env: Env, now: Date): Promise<CronJobResult> {
  const { dump, pruned } = await runCheckedBackup(env.DB, requireBucket(env), {
    now,
    exclude: [...BACKUP_EXCLUDED_TABLES],
    credentials: { allow: BACKUP_CREDENTIAL_ALLOW },
    required: [...BACKUP_REQUIRED_TABLES],
    counted: [...BACKUP_COUNTED_TABLES],
  });
  const rows = dump.tables.reduce((sum, t) => sum + t.rows, 0);
  return {
    rowsProcessed: rows,
    message: `${dump.tables.length} tables, ${rows} rows, ${dump.excluded.length} excluded, pruned ${pruned.pruned}, locked ${pruned.locked}`,
  };
}

/** The blog's media library (MEDIA), copied beside the dumps under files/media/ by d1-dump's backupFiles; each
 *  run goes on where the last stopped. Its own job, so a failed copy never marks the D1 dump failed. */
const MEDIA_BACKUP = { name: "media" };

export async function runMediaBackup(env: Env): Promise<CronJobResult> {
  const run = await backupFiles(env.MEDIA, env.BACKUPS, MEDIA_BACKUP);
  return {
    rowsProcessed: run.worked,
    message: `${run.counts.copied} copied, ${run.counts.skipped} unchanged, ${run.counts.removed} removed${run.complete ? ", pass complete" : ", resumes next run"}`,
  };
}

/** The unauthenticated health fields: age of the newest complete dump, with the media copy's; either one's warning warns. */
export async function backupStatus(env: Env, now = new Date()): Promise<BackupHealth & { files?: { media: BackupHealth } }> {
  if (!env.BACKUPS) {
    return { last_ok: null, age_hours: null, warning: "no backup bucket is bound" } as BackupHealth;
  }
  const [dump, media] = await Promise.all([
    backupHealth(env.BACKUPS, { now }),
    filesHealth(env.BACKUPS, { ...MEDIA_BACKUP, now }),
  ]);
  const warning = [dump.warning, media.warning].filter(Boolean).join("; ");
  return { ...dump, files: { media }, ...(warning ? { warning } : {}) };
}
