// STAGED CHANGES (MCP ruling 2026-10-10, DECIDE answer 4).
//
// The Foxhound Admin API pauses directly, because pausing stops money moving.
// Everything that starts or changes money is STAGED here instead, and applied
// only when an admin confirms it in /admin/staged, signed in:
//
//   resume_account      resume one merchant's processing (it charges cards)
//   release_brake       resume every merchant the emergency brake paused
//   cron_enable         re-enable a cron (the recovery tick charges cards)
//   billing_exempt      change whether an account is billed
//
// CONFIRMING RUNS THE SAME HELPER THE MATCHING /admin SCREEN RUNS, and asks for
// the same typed phrase where that screen does (enabling a cron, releasing the
// brake), so staging adds a person and never a second, weaker path.
//
// Refunds, adjustments, cancel and Stripe disconnect are not kinds and never
// will be: they stay on their own /admin screens.
//
// EVERY TRANSITION IS AUDITED, intent before state, matching the brake panel: a
// failed audit insert leaves nothing changed rather than changed with no record.

import { and, desc, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, getDb, stagedChanges } from "~/db";

import { logAdminAction } from "./audit.server";
import { BRAKE_CONFIRM_PHRASES, cronEnableConfirmPhrase } from "./brake";
import { releaseBrake } from "./brake.server";
import { isKnownCronName, setCronEnabled } from "./crons.server";
import { setBillingExempt, setProcessingPaused } from "./merchants.server";
import { DAY_MS } from "~/lib/constants";

const STAGED_KINDS = ["resume_account", "release_brake", "cron_enable", "billing_exempt"] as const;
type StagedKind = (typeof STAGED_KINDS)[number];

/** A pending change older than this can no longer be confirmed. */
const STAGED_TTL_MS = 7 * DAY_MS;

export type StagedRow = typeof stagedChanges.$inferSelect;

export type StagedOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StageInput {
  kind: unknown;
  accountId?: unknown;
  cronName?: unknown;
  exempt?: unknown;
  note?: unknown;
  requestedBy: string;
  requestedVia: string;
  now: Date;
}

function isKind(value: unknown): value is StagedKind {
  return typeof value === "string" && (STAGED_KINDS as readonly string[]).includes(value);
}

/** One sentence a person or an agent can read in a list. */
export function describeStaged(row: Pick<StagedRow, "kind" | "targetAccountId" | "targetCronName" | "params">): string {
  switch (row.kind) {
    case "resume_account":
      return `Resume processing for ${row.targetAccountId}`;
    case "release_brake":
      return "Release the emergency brake (resume every merchant it paused)";
    case "cron_enable":
      return `Enable the ${row.targetCronName} cron`;
    case "billing_exempt":
      return `${row.params?.exempt ? "Exempt" : "Stop exempting"} ${row.targetAccountId} from billing`;
    default:
      return row.kind;
  }
}

/** The phrase /admin/staged asks for before confirming this row, or null. */
export function stagedConfirmPhrase(row: Pick<StagedRow, "kind" | "targetCronName">): string | null {
  if (row.kind === "cron_enable" && row.targetCronName) return cronEnableConfirmPhrase(row.targetCronName);
  if (row.kind === "release_brake") return BRAKE_CONFIRM_PHRASES.release;
  return null;
}

async function accountExists(db: Db, accountId: string): Promise<boolean> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return rows.length > 0;
}

/** Validate and record a requested change, with its audit entry. Applies nothing. */
export async function stageChange(db: Db, input: StageInput): Promise<StagedOutcome<StagedRow>> {
  if (!isKind(input.kind)) {
    return { ok: false, error: `kind must be one of ${STAGED_KINDS.join(", ")}.` };
  }
  const kind = input.kind;
  const accountId = typeof input.accountId === "string" && input.accountId ? input.accountId : null;
  const cronName = typeof input.cronName === "string" && input.cronName ? input.cronName : null;
  const note = typeof input.note === "string" && input.note ? input.note.slice(0, 500) : null;
  let params: Record<string, unknown> | null = null;

  if (kind === "resume_account" || kind === "billing_exempt") {
    if (!accountId) return { ok: false, error: `${kind} needs account_id. Find one with the merchants read.` };
    if (!(await accountExists(db, accountId))) {
      return { ok: false, error: `No merchant ${accountId}. Find one with the merchants read.` };
    }
  }
  if (kind === "billing_exempt") {
    if (typeof input.exempt !== "boolean") {
      return { ok: false, error: "billing_exempt needs exempt: true to exempt the account, false to bill it again." };
    }
    params = { exempt: input.exempt };
  }
  if (kind === "cron_enable") {
    if (!cronName || !isKnownCronName(cronName)) {
      return { ok: false, error: "cron_enable needs cron_name, one of the crons the health read lists." };
    }
  }

  const id = crypto.randomUUID();
  const row: StagedRow = {
    id,
    kind,
    targetAccountId: kind === "release_brake" || kind === "cron_enable" ? null : accountId,
    targetCronName: kind === "cron_enable" ? cronName : null,
    params,
    note,
    status: "pending",
    requestedBy: input.requestedBy,
    requestedVia: input.requestedVia,
    requestedAt: input.now,
    decidedBy: null,
    decidedAt: null,
    result: null,
  };
  await logAdminAction(db, {
    actorEmail: input.requestedBy,
    action: "staged.create",
    metadata: { stagedId: id, kind, via: input.requestedVia, summary: describeStaged(row) },
  });
  await db.insert(stagedChanges).values(row);
  return { ok: true, value: row };
}

export async function listStagedChanges(db: Db, status: string | null, limit = 200): Promise<StagedRow[]> {
  const query = db.select().from(stagedChanges);
  const rows = await (status ? query.where(eq(stagedChanges.status, status)) : query)
    .orderBy(desc(stagedChanges.requestedAt))
    .limit(limit);
  return rows;
}

async function loadPending(db: Db, id: string, now: Date): Promise<StagedOutcome<StagedRow>> {
  const [row] = await db.select().from(stagedChanges).where(eq(stagedChanges.id, id)).limit(1);
  if (!row) return { ok: false, error: "No such staged change." };
  if (row.status !== "pending") return { ok: false, error: `This change is already ${row.status}.` };
  if (now.getTime() - row.requestedAt.getTime() > STAGED_TTL_MS) {
    return { ok: false, error: "This change is more than seven days old. Ask for it again if it is still wanted." };
  }
  return { ok: true, value: row };
}

/** Move a pending row to a decided status, only if it is still pending. False
 *  when another admin decided it first, so a change is never applied twice. */
async function claim(db: Db, id: string, status: string, actorEmail: string, now: Date): Promise<boolean> {
  const updated = await db
    .update(stagedChanges)
    .set({ status, decidedBy: actorEmail, decidedAt: now })
    .where(and(eq(stagedChanges.id, id), eq(stagedChanges.status, "pending")))
    .returning({ id: stagedChanges.id });
  return updated.length > 0;
}

async function apply(env: Env, row: StagedRow, actorEmail: string, now: Date): Promise<Record<string, unknown>> {
  const db = getDb(env);
  switch (row.kind as StagedKind) {
    case "resume_account":
      await setProcessingPaused(db, row.targetAccountId as string, false);
      return { resumed: row.targetAccountId };
    case "release_brake": {
      const result = await releaseBrake(db, { actorEmail });
      if (result.error) throw new Error(result.error);
      return { resumed: result.affectedCount };
    }
    case "cron_enable":
      await setCronEnabled(db, row.targetCronName as string, true);
      return { enabled: row.targetCronName };
    case "billing_exempt":
      await setBillingExempt(env, row.targetAccountId as string, row.params?.exempt === true, now);
      return { exempt: row.params?.exempt === true };
  }
}

/** Confirm and apply a staged change. Called only from /admin/staged, by a
 *  signed-in admin. */
export async function confirmStagedChange(
  env: Env,
  input: { id: string; actorEmail: string; confirmPhrase: string; now: Date },
): Promise<StagedOutcome<StagedRow>> {
  const db = getDb(env);
  const loaded = await loadPending(db, input.id, input.now);
  if (!loaded.ok) return loaded;
  const row = loaded.value;
  const phrase = stagedConfirmPhrase(row);
  if (phrase !== null && input.confirmPhrase.trim() !== phrase) {
    return { ok: false, error: `Type ${phrase} exactly to confirm. Nothing was changed.` };
  }

  await logAdminAction(db, {
    actorEmail: input.actorEmail,
    action: "staged.confirm",
    metadata: { stagedId: row.id, kind: row.kind, requestedBy: row.requestedBy, summary: describeStaged(row) },
  });
  if (!(await claim(db, row.id, "confirmed", input.actorEmail, input.now))) {
    return { ok: false, error: "Another admin decided this change first." };
  }
  try {
    const result = await apply(env, row, input.actorEmail, input.now);
    await db.update(stagedChanges).set({ result }).where(eq(stagedChanges.id, row.id));
    return { ok: true, value: { ...row, status: "confirmed", decidedBy: input.actorEmail, decidedAt: input.now, result } };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.update(stagedChanges).set({ status: "failed", result: { error } }).where(eq(stagedChanges.id, row.id));
    await logAdminAction(db, {
      actorEmail: input.actorEmail,
      action: "staged.failed",
      metadata: { stagedId: row.id, kind: row.kind, error },
    });
    return { ok: false, error: `Confirmed, but applying it failed: ${error}` };
  }
}

export async function rejectStagedChange(
  db: Db,
  input: { id: string; actorEmail: string; now: Date },
): Promise<StagedOutcome<StagedRow>> {
  const loaded = await loadPending(db, input.id, input.now);
  if (!loaded.ok && !loaded.error.startsWith("This change is more than")) return loaded;
  await logAdminAction(db, {
    actorEmail: input.actorEmail,
    action: "staged.reject",
    metadata: { stagedId: input.id },
  });
  if (!(await claim(db, input.id, "rejected", input.actorEmail, input.now))) {
    return { ok: false, error: "Another admin decided this change first." };
  }
  const [row] = await db.select().from(stagedChanges).where(eq(stagedChanges.id, input.id));
  return { ok: true, value: row };
}
