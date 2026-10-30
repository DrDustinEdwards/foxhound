import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Db } from "~/db";
import {
  changedRows,
  accounts,
  customerContext,
  disputeApprovals,
  disputeBalanceTransactions,
  disputeEvidence,
  disputes,
  stripeConnections,
} from "~/db";
import { sortDisputesNewestFirst } from "~/lib/disputes/order";
import type { DisputeFundsEntry } from "~/lib/disputes/timeline";
import { approveAndSubmit, hashEvidence, type ApproveAndSubmitResult } from "~/lib/disputes/approval";
import {
  buildPendingApprovalBatch,
  buildSubmissionConfirmationBatch,
} from "~/lib/disputes/approval.server";
import { EVIDENCE_FILE_FIELD } from "~/lib/disputes/evidence-files";
import { SUBMITTED_AUTOMATICALLY } from "~/lib/disputes/labels";
import { readEvidenceFilesForSubmission } from "~/lib/disputes/evidence-files.server";
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
type DisputeApprovalRow = typeof disputeApprovals.$inferSelect;

/** Every dispute for the account, newest first. */
export async function listDisputes(db: Db, accountId: string): Promise<DisputeRow[]> {
  const rows = await db.select().from(disputes).where(eq(disputes.accountId, accountId));
  return sortDisputesNewestFirst(rows);
}

export interface DisputeDetail {
  dispute: DisputeRow;
  evidence: DisputeEvidenceRow[];
  approval: DisputeApprovalRow | null;
  /** The money Stripe withdrew and reinstated, oldest first. */
  funds: DisputeFundsEntry[];
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

  const [evidence, approvals, funds] = await Promise.all([
    // Oldest first, then by id: a fixed order, so the page, the draft save and
    // the Stripe payload all take the same row if a field ever has two.
    db
      .select()
      .from(disputeEvidence)
      .where(and(eq(disputeEvidence.disputeId, disputeId), eq(disputeEvidence.accountId, accountId)))
      .orderBy(asc(disputeEvidence.createdAt), asc(disputeEvidence.id)),
    db
      .select()
      .from(disputeApprovals)
      .where(and(eq(disputeApprovals.disputeId, disputeId), eq(disputeApprovals.accountId, accountId))),
    db
      .select({
        kind: disputeBalanceTransactions.kind,
        amountCents: disputeBalanceTransactions.amountCents,
        feeCents: disputeBalanceTransactions.feeCents,
        currency: disputeBalanceTransactions.currency,
        occurredAt: disputeBalanceTransactions.occurredAt,
      })
      .from(disputeBalanceTransactions)
      .where(
        and(
          eq(disputeBalanceTransactions.accountId, accountId),
          eq(disputeBalanceTransactions.stripeDisputeId, dispute.stripeDisputeId),
        ),
      )
      .orderBy(asc(disputeBalanceTransactions.occurredAt), asc(disputeBalanceTransactions.id)),
  ]);

  return { dispute, evidence, approval: approvals[0] ?? null, funds };
}

/**
 * Save Recova's draft fields: the evidence narrative and the customer IP
 * from "Additional evidence", each held as one dispute_evidence row under its
 * Stripe evidence name, so the approved package and its hash carry exactly what
 * the merchant saved. An existing row is updated; a missing one is inserted only
 * when there is something to say, so a blank field never adds a row. The same
 * plain batch as saveDisputeEvidence: editing a draft is not a money write.
 *
 * Every statement carries its own guards, joined to the write,
 * so a check the caller made on an earlier read cannot be raced past:
 * - no dispute_approvals row for this dispute: once a merchant has approved,
 *   the evidence that approval's hash attests is never rewritten, even while
 *   the state is still approvable (Phase A writes the row before Stripe is
 *   called, and a rejected or unconfirmed submission leaves it there);
 * - the INSERT also needs the dispute to be this account's, and no row for the
 *   same field already, so two first-time saves cannot leave two rows.
 * A statement whose guard fails matches nothing and writes nothing, and that
 * is a failure to report, never a success: the result is true
 * only when every statement changed a row. SQLite counts a matched UPDATE even
 * when the value is unchanged, so saving an unchanged draft is still true.
 */
export async function saveDisputeDraft(
  db: Db,
  accountId: string,
  disputeId: string,
  existing: { id: string; fieldName: string }[],
  fields: { fieldName: string; fieldValue: string }[],
  now: Date,
): Promise<boolean> {
  const noApproval = notExists(
    db
      .select({ one: sql`1` })
      .from(disputeApprovals)
      .where(and(eq(disputeApprovals.disputeId, disputeId), eq(disputeApprovals.accountId, accountId))),
  );
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
              noApproval,
            ),
          ),
      );
    } else if (field.fieldValue.trim()) {
      const noSameField = notExists(
        db
          .select({ one: sql`1` })
          .from(disputeEvidence)
          .where(
            and(
              eq(disputeEvidence.disputeId, disputeId),
              eq(disputeEvidence.accountId, accountId),
              eq(disputeEvidence.fieldName, field.fieldName),
            ),
          ),
      );
      statements.push(
        db.insert(disputeEvidence).select(
          db
            .select({
              id: sql<string>`${crypto.randomUUID()}`.as("id"),
              disputeId: disputes.id,
              accountId: disputes.accountId,
              fieldName: sql<string>`${field.fieldName}`.as("field_name"),
              fieldValue: sql<string>`${field.fieldValue}`.as("field_value"),
              createdAt: sql<Date>`${now.getTime()}`.as("created_at"),
            })
            .from(disputes)
            .where(and(eq(disputes.id, disputeId), eq(disputes.accountId, accountId), noApproval, noSameField)),
        ),
      );
    }
  }
  const [first, ...rest] = statements;
  if (!first) return true;
  const results = await db.batch([first, ...rest]);
  return results.every((r) => changedRows(r) > 0);
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
  /** Set when the auto-submit job approves on the merchant's standing opt-in:
   *  when approvedBy* turned auto-submit on. Null for the merchant's own
   *  Approve and submit. It is stored on the approval row, and the submission
   *  is marked SUBMITTED_AUTOMATICALLY instead of with the approver's email. */
  standingOptInAt: Date | null;
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
            standingOptInAt: input.standingOptInAt,
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
    // Phase B. The merchant's evidence files are read from the bucket
    // here, inside the submit step, so Phase A and Phase C are untouched; a
    // file that cannot be read is left out and the submission goes on, as
    // Recova's submit route does, and with no EVIDENCE binding none are sent.
    submit: async () =>
      submitDisputeEvidence(env, {
        stripeDisputeId: input.stripeDisputeId,
        connectionAccessToken: input.connectionAccessToken,
        evidence: evidencePayload,
        files: await readEvidenceFilesForSubmission(env.EVIDENCE, evidence),
      }),
    confirmSubmission: async () => {
      const [result] = await db.batch(
        buildSubmissionConfirmationBatch(db, {
          disputeId: input.disputeId,
          accountId: input.accountId,
          submittedBy: input.standingOptInAt ? SUBMITTED_AUTOMATICALLY : input.approvedByEmail,
          submittedAt: input.approvedAt,
        }),
      );
      // Stripe has the evidence, so a zero-row write means billing will never
      // see this submission. It cannot be retried from here; say so loudly.
      if (changedRows(result) === 0) {
        console.error(
          `dispute submission not recorded: dispute ${input.disputeId} account ${input.accountId} was accepted by Stripe but already carried a submitted marker or no longer exists`,
        );
      }
    },
  });
}

/** D1 caps bound parameters per statement, so an id list is
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
      .select({
        disputeId: disputeEvidence.disputeId,
        fieldName: disputeEvidence.fieldName,
        fieldValue: disputeEvidence.fieldValue,
      })
      .from(disputeEvidence)
      .where(and(eq(disputeEvidence.accountId, accountId), inArray(disputeEvidence.disputeId, chunk)));
    for (const row of rows) {
      // An uploaded file is not drafted evidence: Recova's "Evidence ready"
      // read staged_at, which a file never set.
      if (row.fieldName !== EVIDENCE_FILE_FIELD && row.fieldValue.trim() !== "") found.add(row.disputeId);
    }
  }
  return found;
}

/** S32's dispute settings (/settings/disputes) as their readers need them.
 *  NULL reads as off and empty, as Recova's `?? false` and `?? ''`. */
export async function readDisputeSettings(
  db: Db,
  accountId: string,
): Promise<{ enabled: boolean; productDescription: string; shipsPhysical: boolean; autoSubmit: boolean }> {
  const [row] = await db
    .select({
      enabled: accounts.disputesEnabled,
      productDescription: accounts.disputeProductDescription,
      shipsPhysical: accounts.disputeShipsPhysical,
      autoSubmit: accounts.disputeAutoSubmit,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return {
    enabled: row?.enabled ?? true,
    productDescription: row?.productDescription ?? "",
    shipsPhysical: row?.shipsPhysical ?? false,
    autoSubmit: row?.autoSubmit ?? false,
  };
}

/**
 * The Disputes on/off switch, as dispute intake reads it. Recova's
 * handleDisputeCreated step 1 (lib/dispute-handlers.ts, blob e2bb8de8) returned
 * before doing anything unless the account's disputes product was active; the
 * webhook intake and the manual import both ask this first. A read failure
 * counts as ON, so a database hiccup never drops a chargeback the merchant
 * needs to answer.
 */
export async function readDisputesEnabled(db: Db, accountId: string): Promise<boolean> {
  try {
    return (await readDisputeSettings(db, accountId)).enabled;
  } catch (err) {
    console.error("disputes_enabled read failed; treating Disputes as on", err);
    return true;
  }
}

/** The merchant's own product description for dispute evidence (S32). Recova's
 *  buildEvidenceFields made it the product_description of every response. A
 *  read failure leaves it out rather than failing a dispute intake. */
export async function readDisputeProductDescription(db: Db, accountId: string): Promise<string | null> {
  try {
    const text = (await readDisputeSettings(db, accountId)).productDescription.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}
