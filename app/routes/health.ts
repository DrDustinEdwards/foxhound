import { backupStatus } from "~/lib/backup/d1-backup";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/health";

// Unauthenticated health (job_f7f35d4b7ac7). Only fields safe for anyone to see:
// whether the app answers, and the age of the newest complete D1 dump through
// d1-dump's backupHealth (warns past 26 hours). No counts, no ids, no merchant
// data. Cache-Control is left to the cache policy, which pins unlisted routes
// private/no-store.
//
// THE BACKUP READ IS MEMOIZED PER ISOLATE (job_7bbec6ab48d1). Once BACKUPS is
// bound, backupHealth lists the bucket and reads a marker, and R2 bills a list
// as a Class A operation. This route is public, uncached and not rate limited,
// so without the memo anyone polling it pays R2 per hit. The dump runs once a
// day and the warning threshold is 26 hours, so an answer up to five minutes
// old loses nothing. backupHealth never throws: an R2 error comes back as a
// "backup freshness unreadable" warning, and that answer is held for the same
// five minutes, so an R2 outage shows here and clears within one window.
const BACKUP_STATUS_TTL_MS = 5 * 60_000;
let memo: { at: number; value: Awaited<ReturnType<typeof backupStatus>> } | null = null;

async function cachedBackupStatus(env: Env, nowMs: number) {
  if (memo && nowMs - memo.at < BACKUP_STATUS_TTL_MS) return memo.value;
  const value = await backupStatus(env, new Date(nowMs));
  memo = { at: nowMs, value };
  return value;
}

/** Test seam: forget the memoized backup status. */
export function resetHealthMemoForTests(): void {
  memo = null;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const backup = await cachedBackupStatus(env, Date.now());
  return Response.json({ status: "ok", backup });
}
