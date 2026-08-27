// The cron lock's DECISIONS, as pure functions over the lock's stored state.
//
// WHY THIS FILE EXISTS AT ALL, and it is a testability fix rather than an
// architecture preference. `workers/cron-lock.ts` imports "cloudflare:workers",
// which does not resolve in this repo's node test environment (measured in
// session 62 and recorded as that suite's coverage bound: "Cannot find package
// 'cloudflare:workers'"). So the Durable Object's own lease arithmetic could not
// be driven from vitest at all, and the 310 pin says so out loud: it proves the
// RUNNER honours a denied claim and explicitly does not prove the DO's
// arithmetic. That half rested on source review, which is exactly where 376
// item 14's defect survived.
//
// The arithmetic now lives here, importing nothing, and the DO is a thin shell
// that reads storage, calls these, and writes storage. The plants drive these
// directly against a stub storage map, so the fence is a tested property rather
// than a reviewed one.

/** The fenced lock record, written since 376 item 14. The token names the HOLDER,
 *  which is what makes a release attributable. */
export interface CronLockRecord {
  heldUntil: number;
  token: string;
}

/**
 * Everything the decisions read.
 *
 * `legacyHeldUntil` is the PRE-FENCE value: a bare expiry with no holder, under
 * its own storage key. It is read for exactly one reason, stated so it can be
 * deleted on purpose rather than lingering as mystery code. At the deploy that
 * ships the fence, a run started by the OLD code may still be in flight holding
 * the old key; new code reading only the new key would see no lock and start a
 * second concurrent run of a job that moves money. Reading both closes that one
 * window. It can be removed once one full lease has elapsed after that deploy,
 * because after that no old-format hold can still be live.
 */
export interface CronLockState {
  lock: CronLockRecord | null;
  legacyHeldUntil: number | null;
}

export type AcquireDecision =
  | { granted: false }
  | { granted: true; record: CronLockRecord };

/**
 * Decide whether a caller may take the lock, and with what record.
 *
 * A LEASE, NOT A FLAG: a held lock whose expiry has passed is free, so a run that
 * died without releasing frees the job rather than wedging it forever. `>` and
 * not `>=` so a lease expiring exactly now is expired, which matters only at the
 * boundary and is the boundary the plants drive.
 */
export function decideAcquire(
  state: CronLockState,
  now: number,
  leaseMs: number,
  token: string,
): AcquireDecision {
  if (state.lock !== null && state.lock.heldUntil > now) return { granted: false };
  if (state.legacyHeldUntil !== null && state.legacyHeldUntil > now) return { granted: false };
  return { granted: true, record: { heldUntil: now + leaseMs, token } };
}

/**
 * Decide whether a release may clear the lock: ONLY the holder may (376 item 14).
 *
 * THE DEFECT THIS CLOSES. `release` used to delete the expiry unconditionally,
 * so an overrunning run's release freed a lease it no longer owned. The sequence
 * that bites: tick A overruns its lease, tick B finds the lease expired and
 * acquires, A finally finishes and releases, and B's lease is gone while B is
 * still running. Tick C then acquires alongside B, and two ticks are inside the
 * money path at once. The lease expiring is what lets B in; the unfenced release
 * is what lets C in, and C is the one nothing was stopping.
 *
 * A stale holder's release is a NO-OP rather than an error: it is the expected
 * end of an overrun, not a fault, and there is nothing the caller could do.
 */
export function decideRelease(state: CronLockState, token: string): boolean {
  return state.lock !== null && state.lock.token === token;
}
