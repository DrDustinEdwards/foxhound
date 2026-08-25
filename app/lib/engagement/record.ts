import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, engagementEvents, recoverySteps } from "~/db";

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

/** First-open stamp: sets opened_at once. Open feeds Intelligence only, no attribution. */
export function buildOpenStamp(db: Db, stepId: string, now: Date) {
  return db
    .update(recoverySteps)
    .set({ openedAt: now, lastOpenedAt: now })
    .where(and(eq(recoverySteps.id, stepId), isNull(recoverySteps.openedAt)));
}

/** First-click stamp: sets clicked_at once. This is the email_engaged attribution signal. */
export function buildClickStamp(db: Db, stepId: string, now: Date) {
  return db
    .update(recoverySteps)
    .set({ clickedAt: now, lastClickedAt: now })
    .where(and(eq(recoverySteps.id, stepId), isNull(recoverySteps.clickedAt)));
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
  await db.batch([
    buildEngagementInsert(db, {
      accountId: payload.accountId,
      recoveryStepId: payload.stepId,
      eventType: "click",
      targetUrl: payload.url ?? null,
      idempotencyKey: `click:${payload.stepId}`,
      occurredAt: now,
    }),
    buildClickStamp(db, payload.stepId, now),
  ]);
  return { recorded: true };
}
