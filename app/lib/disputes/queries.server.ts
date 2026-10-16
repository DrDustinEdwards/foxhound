import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import { customerContext, disputeApprovals, disputeEvidence, disputes, stripeConnections } from "~/db";
import { sortDisputesNewestFirst } from "~/lib/disputes/order";
import { approveAndSubmit, hashEvidence, type ApproveAndSubmitResult } from "~/lib/disputes/approval";
import {
  buildPendingApprovalBatch,
  buildSubmissionConfirmationBatch,
} from "~/lib/disputes/approval.server";
import { buildStripeEvidencePayload, submitDisputeEvidence } from "~/lib/disputes/submission";
import { isUniqueConstraintError } from "~/lib/money/serializer";

// Disputes read models + the plain (non-money) evidence-edit write (Phase 5
// slice 5c). Every query is account-scoped. Approval + submission orchestration
// itself is app/lib/disputes/approval.ts's approveAndSubmit (kept there, not
// .server.ts, because canApprove/hashEvidence are plain functions the
// component also needs); this file is reads, the one edit-affordance write,
// and (below) the one place that actually CALLS approveAndSubmit.
//
// getConnectionAccessToken / approveAndSubmitDispute (added for the perf-audit
// ORM-leak fix, foxhound-audit-perf.md M-1): app/routes/app/disputes/
// detail.tsx's action used to call approveAndSubmit({ writePendingApproval:
// async () => { ...db.batch()... }, ... }) directly, passing closures that
// touched drizzle-orm/table objects as VALUES into another function. Simply
// moving those db.select()/db.batch() calls into named .server.ts functions
// did NOT fix the leak (verified: rebuilt, grepped, drizzle symbols were
// still present) as long as detail.tsx itself still constructed the closures
// and called approveAndSubmit directly - every OTHER clean route in this repo
// calls its .server.ts helpers as flat, directly-awaited calls, never wraps
// them in closures passed to another function first. approveAndSubmitDispute
// below is the flat call: it owns the closures AND the approveAndSubmit call
// internally, so detail.tsx's action only ever does
// `await approveAndSubmitDispute(db, env, {...plain data...})`.

export type DisputeRow = typeof disputes.$inferSelect;
export type DisputeEvidenceRow = typeof disputeEvidence.$inferSelect;
export type DisputeApprovalRow = typeof disputeApprovals.$inferSelect;

/** Every dispute for the account, newest first. */
export async function listDisputes(db: Db, accountId: string): Promise<DisputeRow[]> {
  const rows = await db.select().from(disputes).where(eq(disputes.accountId, accountId));
  return sortDisputesNewestFirst(rows);
}

export interface DisputeDetail {
  dispute: DisputeRow;
  evidence: DisputeEvidenceRow[];
  approval: DisputeApprovalRow | null;
}

/** The full review-and-sign view for one dispute, scoped to the account. Null
 *  when the id does not exist or belongs to another account (the route 404s). */
export async function getDisputeDetail(
  db: Db,
  accountId: string,
  disputeId: string,
): Promise<DisputeDetail | null> {
  const rows = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.id, disputeId), eq(disputes.accountId, accountId)))
    .limit(1);
  const dispute = rows[0];
  if (!dispute) return null;

  const [evidence, approvals] = await Promise.all([
    db
      .select()
      .from(disputeEvidence)
      .where(and(eq(disputeEvidence.disputeId, disputeId), eq(disputeEvidence.accountId, accountId))),
    db
      .select()
      .from(disputeApprovals)
      .where(and(eq(disputeApprovals.disputeId, disputeId), eq(disputeApprovals.accountId, accountId))),
  ]);

  return { dispute, evidence, approval: approvals[0] ?? null };
}

/**
 * Save edits to the evidence draft (the "edit affordance"). A plain atomic
 * batch, not a money write, the same way recovery_steps edits are operational
 * (gotcha #25): editing evidence text does not itself gate billing, only
 * approval + submission (approval.ts) and resolution (webhooks/batches.ts) do.
 * Only touches rows that belong to this dispute and account.
 */
export async function saveDisputeEvidence(
  db: Db,
  accountId: string,
  disputeId: string,
  edits: { id: string; fieldValue: string }[],
): Promise<void> {
  if (edits.length === 0) return;
  const statements = edits.map((edit) =>
    db
      .update(disputeEvidence)
      .set({ fieldValue: edit.fieldValue })
      .where(
        and(
          eq(disputeEvidence.id, edit.id),
          eq(disputeEvidence.disputeId, disputeId),
          eq(disputeEvidence.accountId, accountId),
        ),
      ),
  );
  // db.batch() requires a non-empty tuple type; the leading fixed element (the
  // length check above guarantees it exists) narrows the array literal to one.
  const [first, ...rest] = statements;
  await db.batch([first, ...rest]);
}

/**
 * Save Recova's draft fields (J77): the evidence narrative and the customer IP
 * from "Additional evidence", each held as one dispute_evidence row under its
 * Stripe evidence name, so the approved package and its hash carry exactly what
 * the merchant saved. An existing row is updated; a missing one is inserted only
 * when there is something to say, so a blank field never adds a row. The same
 * plain batch as saveDisputeEvidence: editing a draft is not a money write, and
 * approval reads the rows fresh at the moment it is pressed. Account-scoped on
 * every statement.
 */
export async function saveDisputeDraft(
  db: Db,
  accountId: string,
  disputeId: string,
  existing: { id: string; fieldName: string }[],
  fields: { fieldName: string; fieldValue: string }[],
  now: Date,
): Promise<void> {
  const statements: BatchItem<"sqlite">[] = [];
  for (const field of fields) {
    const row = existing.find((e) => e.fieldName === field.fieldName);
    if (row) {
      statements.push(
        db
          .update(disputeEvidence)
          .set({ fieldValue: field.fieldValue })
          .where(
            and(
              eq(disputeEvidence.id, row.id),
              eq(disputeEvidence.disputeId, disputeId),
              eq(disputeEvidence.accountId, accountId),
            ),
          ),
      );
    } else if (field.fieldValue.trim()) {
      statements.push(
        db.insert(disputeEvidence).values({
          id: crypto.randomUUID(),
          disputeId,
          accountId,
          fieldName: field.fieldName,
          fieldValue: field.fieldValue,
          createdAt: now,
        }),
      );
    }
  }
  const [first, ...rest] = statements;
  if (!first) return;
  await db.batch([first, ...rest]);
}

/** The connected Stripe account's access token for a dispute's connection, or
 *  null if the connection row does not exist. `connectionId` is never
 *  client-supplied directly: the caller resolves it from an account-scoped
 *  dispute row first (see getDisputeDetail), so no additional accountId
 *  predicate is added here (that would be a behavior change, not a refactor). */
export async function getConnectionAccessToken(
  db: Db,
  connectionId: string,
): Promise<string | null> {
  const [connection] = await db
    .select({ accessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(eq(stripeConnections.id, connectionId))
    .limit(1);
  return connection?.accessToken ?? null;
}

/** submittedAt for a dispute, scoped to the account, or null if unset/missing. */
async function getDisputeSubmittedAt(
  db: Db,
  accountId: string,
  disputeId: string,
): Promise<Date | null> {
  const [existing] = await db
    .select({ submittedAt: disputes.submittedAt })
    .from(disputes)
    .where(and(eq(disputes.id, disputeId), eq(disputes.accountId, accountId)))
    .limit(1);
  return existing?.submittedAt ?? null;
}

export interface ApproveAndSubmitDisputeInput {
  disputeId: string;
  accountId: string;
  stripeDisputeId: string;
  connectionAccessToken: string;
  approvedByUserId: string | null;
  approvedByEmail: string;
  approvedAt: Date;
}

/**
 * The whole approve-and-submit flow for one dispute, called flatly (a single
 * `await`) from detail.tsx's action. Owns the approveAndSubmit() closures
 * internally (Phase A write, Phase B Stripe submit, Phase C confirm) so
 * nothing in the route file itself constructs a closure over `db` and passes
 * it into another function; see the module comment above for why that
 * distinction is what keeps this out of the client bundle.
 */
export async function approveAndSubmitDispute(
  db: Db,
  env: Env,
  input: ApproveAndSubmitDisputeInput,
  evidence: DisputeEvidenceRow[],
): Promise<ApproveAndSubmitResult> {
  const evidenceVersionHash = await hashEvidence(evidence);
  const evidencePayload = buildStripeEvidencePayload(evidence);

  return approveAndSubmit({
    writePendingApproval: async () => {
      try {
        await db.batch(
          buildPendingApprovalBatch(db, {
            disputeId: input.disputeId,
            accountId: input.accountId,
            approvedByUserId: input.approvedByUserId,
            approvedByEmail: input.approvedByEmail,
            evidenceVersionHash,
            approvedAt: input.approvedAt,
          }),
        );
        return "created";
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        // A row already exists: a CONFIRMED submission (submitted_at set ->
        // reject) or a prior unconfirmed attempt (-> resume and re-submit).
        const submittedAt = await getDisputeSubmittedAt(db, input.accountId, input.disputeId);
        return submittedAt != null ? "already_submitted" : "resume";
      }
    },
    submit: () =>
      submitDisputeEvidence(env, {
        stripeDisputeId: input.stripeDisputeId,
        connectionAccessToken: input.connectionAccessToken,
        evidence: evidencePayload,
      }),
    confirmSubmission: async () => {
      await db.batch(
        buildSubmissionConfirmationBatch(db, {
          disputeId: input.disputeId,
          accountId: input.accountId,
          submittedBy: input.approvedByEmail,
          submittedAt: input.approvedAt,
        }),
      );
    },
  });
}

/** D1 caps bound parameters per statement (RULES.md 3.11), so an id list is
 *  read in chunks well under the cap (health scores and evidence alike). */
const HEALTH_LOOKUP_CHUNK = 90;

/**
 * Intelligence health scores for the given Stripe customers, keyed by Stripe
 * customer id (J66: the disputes list shows one beside each customer, as
 * Recova's does when Intelligence is on). Account-scoped; customers with no
 * score yet are left out rather than reported as zero.
 */
export async function getCustomerHealthScores(
  db: Db,
  accountId: string,
  stripeCustomerIds: string[],
): Promise<Record<string, number>> {
  const ids = [...new Set(stripeCustomerIds)];
  const scores: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += HEALTH_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + HEALTH_LOOKUP_CHUNK);
    const rows = await db
      .select({ stripeCustomerId: customerContext.stripeCustomerId, healthScore: customerContext.healthScore })
      .from(customerContext)
      .where(and(eq(customerContext.accountId, accountId), inArray(customerContext.stripeCustomerId, chunk)));
    for (const row of rows) {
      if (row.healthScore !== null) scores[row.stripeCustomerId] = row.healthScore;
    }
  }
  return scores;
}

/**
 * Which of the given disputes hold at least one non-blank evidence field in
 * Foxhound's draft. The list says Recova's "Evidence ready" only of these
 * (disputeListStatus, labels.ts). Account-scoped on the evidence rows
 * themselves, and chunked under the D1 parameter cap like the health lookup.
 */
export async function getDisputesWithEvidence(db: Db, accountId: string, disputeIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(disputeIds)];
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += HEALTH_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + HEALTH_LOOKUP_CHUNK);
    const rows = await db
      .select({ disputeId: disputeEvidence.disputeId, fieldValue: disputeEvidence.fieldValue })
      .from(disputeEvidence)
      .where(and(eq(disputeEvidence.accountId, accountId), inArray(disputeEvidence.disputeId, chunk)));
    for (const row of rows) {
      if (row.fieldValue.trim() !== "") found.add(row.disputeId);
    }
  }
  return found;
}
