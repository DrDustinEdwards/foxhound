import { DurableObject } from "cloudflare:workers";

// Per-cron mutex Durable Object (ARCHITECTURE.md: "DO replaces the hand-rolled
// lock"). Addressed by idFromName(cronName): every run of one cron hits the same
// instance, so two overlapping firings of the same job cannot both proceed. The
// lock is a lease (an expiry timestamp) so a crashed run that never releases still
// frees the job after the lease lapses, rather than wedging it forever.
export class CronLockDurableObject extends DurableObject<Env> {
  /** Try to take the lock for up to leaseMs. Returns false if it is currently held. */
  async acquire(leaseMs: number): Promise<boolean> {
    const now = Date.now();
    const heldUntil = (await this.ctx.storage.get<number>("heldUntil")) ?? 0;
    if (heldUntil > now) return false;
    await this.ctx.storage.put("heldUntil", now + leaseMs);
    return true;
  }

  /** Release the lock so the next run can acquire immediately. */
  async release(): Promise<void> {
    await this.ctx.storage.delete("heldUntil");
  }
}
