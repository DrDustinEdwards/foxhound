import { DurableObject } from "cloudflare:workers";

import {
  decideAcquire,
  decideRelease,
  type CronLockRecord,
  type CronLockState,
} from "~/lib/cron/lock-state";

// Per-cron mutex Durable Object (ARCHITECTURE.md: "DO replaces the hand-rolled
// lock"). Addressed by idFromName(cronName): every run of one cron hits the same
// instance, so two overlapping firings of the same job cannot both proceed. The
// lock is a lease (an expiry timestamp) so a crashed run that never releases still
// frees the job after the lease lapses, rather than wedging it forever.
//
// FENCED SINCE 376 ITEM 14. `acquire` mints a token and `release` takes one, so
// only the holder can free the lock. Before that, release deleted the expiry
// regardless of who called it, which meant an overrunning run's release freed the
// NEXT run's lease and let a third run in alongside it.
//
// THE ARITHMETIC IS NOT IN THIS FILE. It is in ~/lib/cron/lock-state.ts, which
// imports nothing and is driven directly by the plants, because this module
// imports "cloudflare:workers" and cannot be loaded in the node test
// environment. This class is the storage shell: read, decide, write.

/** The fenced record's storage key. */
const LOCK_KEY = "lock";
/** The pre-fence key, read for one deploy window. See CronLockState. */
const LEGACY_KEY = "heldUntil";

export class CronLockDurableObject extends DurableObject<Env> {
  private async readState(): Promise<CronLockState> {
    const [lock, legacyHeldUntil] = await Promise.all([
      this.ctx.storage.get<CronLockRecord>(LOCK_KEY),
      this.ctx.storage.get<number>(LEGACY_KEY),
    ]);
    return { lock: lock ?? null, legacyHeldUntil: legacyHeldUntil ?? null };
  }

  /**
   * Try to take the lock for up to leaseMs.
   *
   * RETURNS THE HOLDER'S TOKEN, or null when the lock is held. The token is the
   * fence: the caller hands it back to `release`, and a caller that never
   * acquired has nothing to hand back. Returning a token rather than a boolean
   * is what makes the runner's `finally` able to release only its own lease.
   */
  async acquire(leaseMs: number): Promise<string | null> {
    const now = Date.now();
    const token = crypto.randomUUID();
    const decision = decideAcquire(await this.readState(), now, leaseMs, token);
    if (!decision.granted) return null;
    await this.ctx.storage.put(LOCK_KEY, decision.record);
    // The old key is cleared as soon as a fenced holder takes over, so the
    // compatibility read above stops mattering after the first acquire per cron.
    await this.ctx.storage.delete(LEGACY_KEY);
    return decision.record.token;
  }

  /** Release the lock so the next run can acquire immediately, but ONLY if this
   *  caller still holds it. A stale holder's release does nothing. */
  async release(token: string): Promise<void> {
    if (!decideRelease(await this.readState(), token)) return;
    await this.ctx.storage.delete(LOCK_KEY);
  }
}
