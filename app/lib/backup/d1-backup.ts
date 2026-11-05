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
    credentials: { allow: BACKUP_CREDENTIAL_ALLOW },
    required: [...BACKUP_REQUIRED_TABLES],
  });
  const rows = dump.tables.reduce((sum, t) => sum + t.rows, 0);
  return {
    rowsProcessed: rows,
    message: `${dump.tables.length} tables, ${rows} rows, ${dump.excluded.length} excluded, pruned ${pruned.pruned}, locked ${pruned.locked}`,
  };
}

/** The bucket copies beside the dumps, each under files/<name>/ by d1-dump's backupFiles; each run goes on where the
 *  last stopped, and Capsid's nightly off-account copy takes all of files/ to Amazon. MEDIA is the blog's media
 *  library. EVIDENCE is the merchants' dispute evidence files, which exist nowhere else once uploaded. Each has its
 *  own job, so a failed copy never marks the D1 dump or the other copy failed. */
const MEDIA_BACKUP = { name: "media" };
const EVIDENCE_BACKUP = { name: "evidence" };

async function runFilesBackup(source: Env["MEDIA"], env: Env, options: { name: string }): Promise<CronJobResult> {
  const run = await backupFiles(source, env.BACKUPS, options);
  return {
    rowsProcessed: run.worked,
    message: `${run.counts.copied} copied, ${run.counts.skipped} unchanged, ${run.counts.removed} removed${run.complete ? ", pass complete" : ", resumes next run"}`,
  };
}

export const runMediaBackup = (env: Env) => runFilesBackup(env.MEDIA, env, MEDIA_BACKUP);
export const runEvidenceBackup = (env: Env) => runFilesBackup(env.EVIDENCE, env, EVIDENCE_BACKUP);

/** Both files passes now, for the admin API's "run the backup now" (the admin MCP). The same backupFiles calls as the
 *  media-backup and evidence-backup cron jobs, copy only: nothing is written or deleted in MEDIA or EVIDENCE. A failed
 *  pass throws after the other has run. */
export async function backupFilesNow(env: Env) {
  const passes = [
    { name: MEDIA_BACKUP.name, source: env.MEDIA },
    { name: EVIDENCE_BACKUP.name, source: env.EVIDENCE },
  ];
  const results = await Promise.allSettled(passes.map((p) => backupFiles(p.source, requireBucket(env), { name: p.name })));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${passes[i]?.name}: ${String(r.reason)}`] : []));
  if (failed.length > 0) throw new Error(`files backup failed: ${failed.join("; ")}`);
  return results.map((r) => {
    const run = (r as PromiseFulfilledResult<Awaited<ReturnType<typeof backupFiles>>>).value;
    return { name: run.name, complete: run.complete, ...run.counts };
  });
}

/** The unauthenticated health fields: age of the newest complete dump, with each files copy's; any one's warning warns. */
export async function backupStatus(
  env: Env,
  now = new Date(),
): Promise<BackupHealth & { files?: { media: BackupHealth; evidence: BackupHealth } }> {
  if (!env.BACKUPS) {
    return { last_ok: null, age_hours: null, warning: "no backup bucket is bound" } as BackupHealth;
  }
  const [dump, media, evidence] = await Promise.all([
    backupHealth(env.BACKUPS, { now }),
    filesHealth(env.BACKUPS, { ...MEDIA_BACKUP, now }),
    filesHealth(env.BACKUPS, { ...EVIDENCE_BACKUP, now }),
  ]);
  const warning = [dump.warning, media.warning, evidence.warning].filter(Boolean).join("; ");
  return { ...dump, files: { media, evidence }, ...(warning ? { warning } : {}) };
}
