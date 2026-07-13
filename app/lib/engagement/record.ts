import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, engagementEvents, recoverySteps } from "~/db";

import type { EngagementTokenPayload } from "./token";

// First-party engagement recording. A verified open/click hit writes an idempotent
// engagement_events row (unique on idempotency_key: `open:<stepId>` / `click:<stepId>`,
// so re-hits collapse) and stamps the recovery step. The CLICK stamp sets
// recovery_steps.clicked_at, which is the email_engaged attribution signal the
// invoice.payment_succeeded webhook reads (PRICING.md: click is billable, open is
// Intelligence-only). Operational writes (not money), so a plain db.batch().

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

export async function recordOpen(env: Env, payload: EngagementTokenPayload): Promise<void> {
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
}

export async function recordClick(env: Env, payload: EngagementTokenPayload): Promise<void> {
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
}
