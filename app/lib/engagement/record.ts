import { and, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, engagementEvents, recoverySteps } from "~/db";

import {
  CLICK_SUSPECT_HONEYPOT,
  CLICK_SUSPECT_MIN_MS,
  CLICK_SUSPECT_TOO_FAST,
} from "~/lib/constants";

import type { EngagementRecordResult, EngagementSource } from "./agents";
import type { EngagementTokenPayload } from "./token";

// First-party engagement recording. A verified open/click hit writes an idempotent
// engagement_events row (unique on idempotency_key: `open:<stepId>` / `click:<stepId>`,
// so re-hits collapse) and stamps the recovery step. The CLICK stamp sets
// recovery_steps.clicked_at, which is the email_engaged attribution signal the
// invoice.payment_succeeded webhook reads (PRICING.md: click is billable, open is
// Intelligence-only). Operational writes (not money), so a plain db.batch().
//
// THE SOURCE ARGUMENT IS REQUIRED, AND THAT IS THE GUARD (368 ruling 1). Both
// recorders take an `EngagementSource` and write NOTHING when it is automated.
// Required rather than optional-defaulting-to-human, because a new caller that
// forgets it must fail to COMPILE rather than quietly resume fabricating clicks.
// The classification lives in ./agents.ts; the refusal lives HERE, at the write,
// so a caller reaching the recorder from somewhere other than the redirect route
// cannot route around it.
//
// BOTH RECORDERS, NOT ONLY THE BILLABLE ONE. The click is what 368 ruled on,
// because clicked_at is what findAttributionSignals reads and email_engaged is
// what gets invoiced. The open pixel writes the same shape of fabricated row and
// stamps opened_at, which feeds Intelligence rather than billing. Guarding one
// and not the other would be the N-1-of-N miss the enumerate-every-site rule
// exists for: one bug class, two sites, one helper.

export function buildEngagementInsert(
  db: Db,
  input: {
    accountId: string;
    recoveryStepId: string;
    eventType: "open" | "click";
    targetUrl?: string | null;
    idempotencyKey: string;
    occurredAt: Date;
  },
) {
  return db
    .insert(engagementEvents)
    .values({
      accountId: input.accountId,
      recoveryStepId: input.recoveryStepId,
      eventType: input.eventType,
      targetUrl: input.targetUrl ?? null,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt,
      createdAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: engagementEvents.idempotencyKey });
}

/**
 * The open stamp, written on EVERY human open (row F9). Open feeds Intelligence
 * only, no attribution. Recova's email.opened handler (webhooks/resend/route.ts)
 * is the spec for what one open does to the step:
 *
 *   email_opened_count   + 1, a NULL read as 0             every open
 *   last_opened_at       now                                every open
 *   opened_at            now                                first open only
 *   time_to_open_minutes whole minutes from executed_at     once, and only when
 *                        to the first open                  executed_at is set
 *
 * One UPDATE, so the counter is read and written by the database rather than in
 * the Worker: two opens racing each other both count. SQLite evaluates every
 * SET expression against the row as it was, so time to open reads the OLD
 * opened_at: on a first open that is NULL and the time is now, as Recova
 * computes it; on a step first opened before this stamp kept a time, it is that
 * real first open rather than this later one. Timestamps are epoch milliseconds
 * (schema.ts `ts`), so the minutes are the gap divided by 60000 and floored,
 * Recova's Math.floor, negative gaps included.
 */
export function buildOpenStamp(db: Db, stepId: string, now: Date) {
  const nowMs = now.getTime();
  const firstOpenMs = sql`coalesce(${recoverySteps.openedAt}, ${nowMs})`;
  // Whole minutes as a true floor. SQLite's integer division truncates toward
  // zero, so a negative gap that is not a whole number of minutes (an open
  // stamped before executed_at, clock skew) takes one more off, as Math.floor.
  const gapMs = sql`(${firstOpenMs} - ${recoverySteps.executedAt})`;
  const floorMinutes = sql`(cast(${gapMs} / 60000 as integer) - (case when ${gapMs} < 0 and ${gapMs} % 60000 != 0 then 1 else 0 end))`;
  return db
    .update(recoverySteps)
    .set({
      emailOpenedCount: sql`coalesce(${recoverySteps.emailOpenedCount}, 0) + 1`,
      lastOpenedAt: now,
      openedAt: firstOpenMs,
      timeToOpenMinutes: sql`case
        when ${recoverySteps.timeToOpenMinutes} is null and ${recoverySteps.executedAt} is not null
          then ${floorMinutes}
        else ${recoverySteps.timeToOpenMinutes}
      end`,
    })
    .where(eq(recoverySteps.id, stepId));
}

/** First-click stamp: sets clicked_at once. This is the email_engaged attribution signal.
 *
 *  `suspectReason` is written ONLY when there is one. Passing null must not
 *  clear an existing mark: the honeypot can be fetched before the real click
 *  arrives, and a stamp that blanked the column would launder exactly the click
 *  the honeypot caught. */
export function buildClickStamp(db: Db, stepId: string, now: Date, suspectReason: string | null) {
  return db
    .update(recoverySteps)
    .set(
      suspectReason
        ? { clickedAt: now, lastClickedAt: now, clickSuspectReason: suspectReason }
        : { clickedAt: now, lastClickedAt: now },
    )
    .where(and(eq(recoverySteps.id, stepId), isNull(recoverySteps.clickedAt)));
}

/**
 * Mark a step's click suspect because the invisible honeypot link in its email
 * was fetched (ruling 377(4) phase one).
 *
 * Unconditional on clicked_at: the fetch order is not ours to control, so this
 * marks the step whether the real click has already landed or has not arrived
 * yet. It never clears a reason that is already there.
 */
export function buildHoneypotStamp(db: Db, stepId: string) {
  return db
    .update(recoverySteps)
    .set({ clickSuspectReason: CLICK_SUSPECT_HONEYPOT })
    .where(and(eq(recoverySteps.id, stepId), isNull(recoverySteps.clickSuspectReason)));
}

export async function recordOpen(
  env: Env,
  payload: EngagementTokenPayload,
  source: EngagementSource,
): Promise<EngagementRecordResult> {
  if (source.automated) return { recorded: false, reason: source.reason };

  const db = getDb(env);
  const now = new Date();
  await db.batch([
    buildEngagementInsert(db, {
      accountId: payload.accountId,
      recoveryStepId: payload.stepId,
      eventType: "open",
      idempotencyKey: `open:${payload.stepId}`,
      occurredAt: now,
    }),
    buildOpenStamp(db, payload.stepId, now),
  ]);
  return { recorded: true };
}

/**
 * THE BILLABLE ONE. `buildClickStamp` sets `recovery_steps.clicked_at`, which
 * `findAttributionSignals` reads as the `email_engaged` signal, which is in
 * `BILLABLE_ATTRIBUTION_KINDS`. An automated source returns BEFORE the batch, so
 * neither the engagement_events row nor the stamp is written and no attribution
 * can arise from the request.
 */
export async function recordClick(
  env: Env,
  payload: EngagementTokenPayload,
  source: EngagementSource,
): Promise<EngagementRecordResult> {
  if (source.automated) return { recorded: false, reason: source.reason };

  const db = getDb(env);
  const now = new Date();

  // THE ONLY DISCRIMINATOR ALREADY STORED. An enterprise link scanner presents a
  // full browser user agent, so 369's named-bot list cannot see it, but it
  // fetches on delivery: seconds after the send, not minutes. This reads the
  // gap the schema has always carried and nothing ever looked at.
  const [step] = await db
    .select({ executedAt: recoverySteps.executedAt })
    .from(recoverySteps)
    .where(eq(recoverySteps.id, payload.stepId))
    .limit(1);
  const tooFast =
    step?.executedAt != null && now.getTime() - step.executedAt.getTime() < CLICK_SUSPECT_MIN_MS;

  await db.batch([
    buildEngagementInsert(db, {
      accountId: payload.accountId,
      recoveryStepId: payload.stepId,
      eventType: "click",
      targetUrl: payload.url ?? null,
      idempotencyKey: `click:${payload.stepId}`,
      occurredAt: now,
    }),
    buildClickStamp(db, payload.stepId, now, tooFast ? CLICK_SUSPECT_TOO_FAST : null),
  ]);
  return { recorded: true };
}

/**
 * A fetch of the invisible honeypot link. THE CLICK IS STILL RECORDED, and this
 * only marks it, because a suppressed click would be indistinguishable from a
 * customer who never engaged and the merchant would lose the evidence trail.
 * What changes is that it can never bill.
 */
export async function recordHoneypot(
  env: Env,
  payload: EngagementTokenPayload,
): Promise<EngagementRecordResult> {
  // NO engagement_events ROW. That table's event_type carries a CHECK
  // constraint pinned to ('open', 'click'), and SQLite cannot widen a CHECK
  // without rebuilding the table, which is not a migration this change earns:
  // engagement_events records what the CUSTOMER did, and a honeypot fetch is by
  // definition not that. The mark on the step is the record, and its reason
  // column says which test the click failed, which is what the ledger reads.
  const db = getDb(env);
  await db.batch([buildHoneypotStamp(db, payload.stepId)]);
  return { recorded: true };
}
