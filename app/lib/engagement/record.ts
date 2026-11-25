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

// First-party engagement recording. A verified open/click writes an idempotent engagement_events row
// (unique idempotency_key `open:<stepId>` / `click:<stepId>`) and stamps the recovery step. The click
// stamp sets clicked_at, the billable email_engaged signal, so the click is a money write committed
// through the account's money Durable Object; the open feeds no bill and is a plain db.batch().
// Both recorders require an `EngagementSource` and write NOTHING when it is automated: required (not
// defaulting to human) so a new caller fails to compile, and enforced here at the write so no caller
// can route around ./agents.ts.

function buildEngagementInsert(
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
 * The open stamp, written on every human open (Intelligence only, no attribution): open count + 1 (NULL
 * as 0), last_opened_at now, opened_at and time_to_open_minutes on the first open. One UPDATE, so the
 * counter is read and written by the database and racing opens both count; SQLite evaluates every SET
 * against the old row, so time to open reads the OLD opened_at. Timestamps are epoch ms.
 */
function buildOpenStamp(db: Db, stepId: string, now: Date) {
  const nowMs = now.getTime();
  const firstOpenMs = sql`coalesce(${recoverySteps.openedAt}, ${nowMs})`;
  // Whole minutes as a true floor: SQLite's integer division truncates toward zero, so a negative gap that
  // is not a whole number of minutes (clock skew) takes one more off.
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
 * The click stamp, written on every human click: click count + 1, last_clicked_at now, and clicked_at
 * and click_suspect_reason on the first click only (they feed attribution and billing). One UPDATE, so
 * `clicked_at is null` means "first click" for every column at once.
 *
 * The too-fast test is decided in this statement, against the row as the money Durable Object commits it.
 * A first click is too_fast under CLICK_SUSPECT_MIN_MS after executed_at, or when executed_at is not
 * written yet: emails send first and claim second, so that is the scanner fetch this test exists for.
 * Reading a missing executed_at as "not too fast" let it bill; reading it as too fast fails safe. A
 * first click that is not too fast never clears an earlier honeypot mark; a repeat never changes it.
 */
function buildClickStamp(db: Db, stepId: string, now: Date) {
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

/** Mark a step's click suspect because the honeypot link was fetched. Unconditional on clicked_at (fetch
 *  order is not ours to control); never clears an existing reason. */
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
 * The billable recorder. An automated source returns BEFORE the batch, so no event row or stamp is
 * written and no attribution can arise. The event row and stamp commit as one atomic batch through the
 * account's money Durable Object, serialized with every other money write. The event row keeps its own
 * `click:<stepId>` key; the Durable Object's key is per click, since every click moves the counter and
 * a shared key would make each repeat a no-op.
 */
export async function recordClick(
  env: Env,
  payload: EngagementTokenPayload,
  source: EngagementSource,
): Promise<EngagementRecordResult> {
  if (source.automated) return { recorded: false, reason: source.reason };

  const db = getDb(env);
  const now = new Date();

  // A zero-row stamp is not a recorded click: with no step the stamp matches nothing and the event row's
  // foreign key refuses, so name the outcome here. The too-fast test is not read here; the stamp decides it at commit.
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

/** A fetch of the honeypot link. The click is still recorded and only marked (a suppressed click would
 *  look like no engagement and lose the evidence); it can never bill. */
export async function recordHoneypot(
  env: Env,
  payload: EngagementTokenPayload,
): Promise<EngagementRecordResult> {
  // No engagement_events row: its event_type CHECK is ('open', 'click') and a honeypot fetch is not a
  // customer action. The mark on the step, with its reason column, is the record.
  const db = getDb(env);
  await db.batch([buildHoneypotStamp(db, payload.stepId)]);
  return { recorded: true };
}
