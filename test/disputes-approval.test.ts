import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  approvalRaceErrorMessage,
  approveAndSubmit,
  canApprove,
  hashEvidence,
  type ApproveAndSubmitDeps,
  type PendingApprovalOutcome,
} from "~/lib/disputes/approval";
import { buildPendingApprovalBatch, buildSubmissionConfirmationBatch } from "~/lib/disputes/approval.server";
import type { DisputeSubmissionResult } from "~/lib/disputes/submission";

const now = new Date("2026-07-18T00:00:00.000Z");
const db = drizzle({} as never, { schema });

function sqlOf(item: unknown): { sql: string; params: unknown[] } {
  return (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

describe("canApprove", () => {
  it("allows every pre-submission state", () => {
    expect(canApprove("draft")).toBe(true);
    expect(canApprove("pending_review")).toBe(true);
    expect(canApprove("approved")).toBe(true);
  });

  it("blocks a dispute that is already submitted or resolved (no re-approval, no reopen)", () => {
    expect(canApprove("submitted")).toBe(false);
    expect(canApprove("resolved_won")).toBe(false);
    expect(canApprove("resolved_lost")).toBe(false);
  });
});

describe("approvalRaceErrorMessage (Phase 5 review MEDIUM fix: the race loser's handled path)", () => {
  it("maps a unique-constraint violation on the approval batch to the same clean message the sequential pre-check uses", () => {
    const err = new Error("UNIQUE constraint failed: dispute_approvals.dispute_id");
    expect(approvalRaceErrorMessage(err)).toBe("This dispute has already been submitted.");
  });

  it("also recognizes a primary-key constraint violation", () => {
    const err = new Error("D1_ERROR: PRIMARY KEY constraint failed: dispute_approvals.id");
    expect(approvalRaceErrorMessage(err)).toBe("This dispute has already been submitted.");
  });

  it("returns null (the caller rethrows) for an unrelated failure", () => {
    expect(approvalRaceErrorMessage(new Error("network timeout"))).toBeNull();
    expect(approvalRaceErrorMessage(new Error("D1_ERROR: too many statements"))).toBeNull();
  });
});

describe("hashEvidence", () => {
  it("is deterministic regardless of field order", () => {
    const a = [
      { fieldName: "product_description", fieldValue: "Widget" },
      { fieldName: "customer_email_address", fieldValue: "a@b.com" },
    ];
    const b = [...a].reverse();
    return Promise.all([hashEvidence(a), hashEvidence(b)]).then(([h1, h2]) => {
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("changes when a field value changes (proves which version was approved)", async () => {
    const before = await hashEvidence([{ fieldName: "product_description", fieldValue: "Widget" }]);
    const after = await hashEvidence([{ fieldName: "product_description", fieldValue: "Widget v2" }]);
    expect(before).not.toBe(after);
  });
});

describe("buildPendingApprovalBatch (Phase A: durable record BEFORE Stripe)", () => {
  it("writes ONLY the dispute_approvals row and does not advance dispute state", () => {
    const batch = buildPendingApprovalBatch(db, {
      disputeId: "dsp_1",
      accountId: "acc_1",
      approvedByUserId: "user_1",
      approvedByEmail: "owner@example.com",
      evidenceVersionHash: "abc123",
      approvedAt: now,
    });
    // Just the approval insert: the state is NOT advanced pre-Stripe, so a
    // Stripe failure leaves a retriable dispute, never a false `submitted`.
    expect(batch.length).toBe(1);
    const approvalInsert = sqlOf(batch[0]);
    expect(approvalInsert.sql).toMatch(/insert into .*dispute_approvals/i);
    expect(approvalInsert.params).toContain("abc123");
    expect(approvalInsert.params).toContain("dsp_1");
    // Nothing in this batch touches the disputes table / the submitted marker.
    expect(approvalInsert.sql).not.toMatch(/update .*disputes/i);
  });
});

describe("buildSubmissionConfirmationBatch (Phase C: submitted marker AFTER Stripe)", () => {
  it("advances the dispute to submitted and sets submitted_at, guarded by state", () => {
    const batch = buildSubmissionConfirmationBatch(db, {
      disputeId: "dsp_1",
      accountId: "acc_1",
      submittedBy: "owner@example.com",
      submittedAt: now,
    });
    expect(batch.length).toBe(1);
    const update = sqlOf(batch[0]);
    expect(update.sql).toMatch(/update .*disputes/i);
    expect(update.sql).toMatch(/submitted_at/i);
    expect(update.sql).toMatch(/not in/i); // only from a pre-submission/pre-resolution state
    expect(update.params).toContain("submitted");
    expect(update.params).toContain("dsp_1");
  });
});

describe("approveAndSubmit (record and submission can never diverge: review MEDIUM)", () => {
  // A recording harness for the three ordered phases. Each phase pushes its
  // name so the test can assert exact call order and that later phases never
  // run when an earlier one short-circuits.
  function harness(over: Partial<{
    pending: PendingApprovalOutcome;
    submit: DisputeSubmissionResult;
    confirmThrows: boolean;
  }> = {}) {
    const calls: string[] = [];
    const deps: ApproveAndSubmitDeps = {
      writePendingApproval: async () => {
        calls.push("pending");
        return over.pending ?? "created";
      },
      submit: async () => {
        calls.push("submit");
        return over.submit ?? { ok: true };
      },
      confirmSubmission: async () => {
        calls.push("confirm");
        if (over.confirmThrows) throw new Error("D1_ERROR: database is locked");
      },
    };
    return { calls, deps };
  }

  it("happy path: pending record is written BEFORE submit, and confirm runs only AFTER submit succeeds", async () => {
    const { calls, deps } = harness();
    const result = await approveAndSubmit(deps);
    expect(result).toEqual({ status: "submitted" });
    // The exact ordering is the invariant: the durable record precedes Stripe,
    // the submitted marker follows a successful Stripe call.
    expect(calls).toEqual(["pending", "submit", "confirm"]);
  });

  it("a failed Stripe submission NEVER writes the submitted marker (confirm is not reached)", async () => {
    const { calls, deps } = harness({ submit: { ok: false, error: "evidence too long" } });
    const result = await approveAndSubmit(deps);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toContain("evidence too long");
    // Pending record exists (written before Stripe), but confirm never ran:
    // no submitted_at, so billing never counts this dispute. Retriable.
    expect(calls).toEqual(["pending", "submit"]);
    expect(calls).not.toContain("confirm");
  });

  it("an already-confirmed submission is rejected before any Stripe call", async () => {
    const { calls, deps } = harness({ pending: "already_submitted" });
    const result = await approveAndSubmit(deps);
    expect(result.status).toBe("error");
    // Neither submit nor confirm runs: no re-submission of an already-submitted dispute.
    expect(calls).toEqual(["pending"]);
  });

  it("resume (a prior unconfirmed attempt) proceeds through submit and confirm", async () => {
    const { calls, deps } = harness({ pending: "resume" });
    const result = await approveAndSubmit(deps);
    expect(result).toEqual({ status: "submitted" });
    expect(calls).toEqual(["pending", "submit", "confirm"]);
  });

  it("a post-Stripe confirmation failure propagates (Stripe has it, our marker did not land): surfaced, never swallowed", async () => {
    const { calls, deps } = harness({ confirmThrows: true });
    await expect(approveAndSubmit(deps)).rejects.toThrow(/database is locked/);
    // The pending record still exists (no divergence to a record-less submission);
    // the throw is what the route captures to Sentry and re-raises.
    expect(calls).toEqual(["pending", "submit", "confirm"]);
  });
});
