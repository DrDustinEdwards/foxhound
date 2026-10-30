import { and, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, engagementEvents, recoverySteps } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

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
// Intelligence-only). So the CLICK is a money write and commits through the
// account's money Durable Object (Dustin, 2026-10-25: "Yes, treat it as money";
// RULES.md 3.4). The open feeds no bill and stays a plain db.batch().
//
// THE SOURCE ARGUMENT IS REQUIRED, AND THAT IS THE GUARD. Both
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
 * The open stamp, written on EVERY human open. Open feeds Intelligence
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

/**
 * The click stamp, written on EVERY human click. Recova's
 * email.clicked handler (webhooks/resend/route.ts) is the spec for what one
 * click does to the step:
 *
 *   email_clicked_count  + 1, a NULL read as 0   every click
 *   last_clicked_at      now                      every click
 *   clicked_at           now                      first click only
 *
 * clicked_at is the email_engaged attribution signal and click_suspect_reason
 * decides whether it may bill, so BOTH STAY FIRST-CLICK ONLY:
 * they change exactly as they did when this stamp matched only a step with no
 * click yet. A repeat click moves the counter and the last-click time, which
 * nothing in attribution or billing reads. One UPDATE, so SQLite evaluates
 * every SET expression against the row as it was: `clicked_at is null` below
 * means "this is the first click" for every column at once.
 *
 * THE TOO-FAST TEST IS DECIDED IN THIS STATEMENT, against the row as the
 * money Durable Object commits it, not from a read taken earlier in the Worker.
 * A first click is too_fast when it lands under CLICK_SUSPECT_MIN_MS after
 * executed_at, OR WHEN executed_at IS NOT WRITTEN YET. Emails send first and
 * claim second, so a click on a step with no executed_at is a
 * click in the seconds between the send and its claim: exactly the scanner
 * fetch this test exists for. Reading a missing executed_at as "not too fast"
 * let that fetch bill. The cost of reading it as too fast falls the safe way: a
 * real person who clicks while a claim is failing is marked suspect and never
 * bills, rather than a scanner billing.
 *
 * A first click that is not too fast leaves click_suspect_reason as it was, so
 * a honeypot mark written before the real click arrives is never cleared; a
 * repeat click never changes it at all.
 */
export function buildClickStamp(db: Db, stepId: string, now: Date) {
  const nowMs = now.getTime();
  return db
    .update(recoverySteps)
    .set({
      emailClickedCount: sql`coalesce(${recoverySteps.emailClickedCount}, 0) + 1`,
      lastClickedAt: now,
      clickedAt: sql`coalesce(${recoverySteps.clickedAt}, ${nowMs})`,
      clickSuspectReason: sql`case
        when ${recoverySteps.clickedAt} is null
          and (${recoverySteps.executedAt} is null or ${nowMs} - ${recoverySteps.executedAt} < ${CLICK_SUSPECT_MIN_MS})
          then ${CLICK_SUSPECT_TOO_FAST}
        else ${recoverySteps.clickSuspectReason}
      end`,
    })
    .where(eq(recoverySteps.id, stepId));
}

/**
 * Mark a step's click suspect because the invisible honeypot link in its email
 * was fetched.
 *
 * Unconditional on clicked_at: the fetch order is not ours to control, so this
 * marks the step whether the real click has already landed or has not arrived
 * yet. It never clears a reason that is already there.
 */
function buildHoneypotStamp(db: Db, stepId: string) {
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
 *
 * A MONEY WRITE: the event row and the stamp commit as one
 * atomic batch through this account's money Durable Object, in that order, so a
 * click is serialized with every other money write for the account. The event
 * row keeps its own exactly-once key, `click:<stepId>`, which collapses re-hits
 * to one row. The Durable Object's key is per click and not that key, because
 * every click moves the counter and the last-click time (F10), and a key shared
 * by every click on a step would make each repeat click a no-op.
 */
export async function recordClick(
  env: Env,
  payload: EngagementTokenPayload,
  source: EngagementSource,
): Promise<EngagementRecordResult> {
  if (source.automated) return { recorded: false, reason: source.reason };

  const db = getDb(env);
  const now = new Date();

  // A ZERO-ROW STAMP IS NOT A RECORDED CLICK. With no step the
  // stamp would match nothing (and the event row's foreign key would refuse
  // the insert), so the outcome is named here, before the batch, rather than
  // reported as recorded or left to surface as a thrown constraint error.
  // The too-fast test (the gap from executed_at, the one discriminator already
  // stored that sees a scanner with a browser user agent) is not read here: the
  // stamp decides it at commit, so a claim landing in between cannot be missed.
  const [step] = await db
    .select({ id: recoverySteps.id })
    .from(recoverySteps)
    .where(eq(recoverySteps.id, payload.stepId))
    .limit(1);
  if (!step) return { recorded: false, reason: "unknown_step" };

  await executeMoneyWrite(env, {
    accountId: payload.accountId,
    idempotencyKey: `click:${payload.stepId}:${now.getTime()}:${crypto.randomUUID()}`,
    build: (tx) => [
      buildEngagementInsert(tx, {
        accountId: payload.accountId,
        recoveryStepId: payload.stepId,
        eventType: "click",
        targetUrl: payload.url ?? null,
        idempotencyKey: `click:${payload.stepId}`,
        occurredAt: now,
      }),
      buildClickStamp(tx, payload.stepId, now),
    ],
  });
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
