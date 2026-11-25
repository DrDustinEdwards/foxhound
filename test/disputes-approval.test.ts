import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  approveAndSubmit,
  hashEvidence,
  type ApproveAndSubmitDeps,
  type PendingApprovalOutcome,
} from "~/lib/disputes/approval";
import {
  buildPendingApprovalBatch,
  buildSubmissionConfirmationBatch,
} from "~/lib/disputes/approval.server";
import type { DisputeSubmissionResult } from "~/lib/disputes/submission";

const now = new Date("2026-07-18T00:00:00.000Z");
const db = drizzle({} as never, { schema });

function sqlOf(item: unknown): { sql: string; params: unknown[] } {
  return (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

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
    const after = await hashEvidence([
      { fieldName: "product_description", fieldValue: "Widget v2" },
    ]);
    expect(before).not.toBe(after);
  });
});

describe("buildPendingApprovalBatch", () => {
  it("writes ONLY the dispute_approvals row and does not advance dispute state", () => {
    const batch = buildPendingApprovalBatch(db, {
      disputeId: "dsp_1",
      accountId: "acc_1",
      approvedByUserId: "user_1",
      approvedByEmail: "owner@example.com",
      evidenceVersionHash: "abc123",
      approvedAt: now,
      standingOptInAt: null,
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

describe("buildSubmissionConfirmationBatch", () => {
  it("sets submitted_at once, keeping a resolved dispute's state", () => {
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
    expect(update.sql).toMatch(/"submitted_at" is null/i); // written once
    expect(update.sql).toMatch(/case when/i); // a resolved state is kept
    expect(update.params).toContain("submitted");
    expect(update.params).toContain("dsp_1");
  });
});

describe("approveAndSubmit", () => {
  function harness(
    over: Partial<{
      pending: PendingApprovalOutcome;
      submit: DisputeSubmissionResult;
      confirmThrows: boolean;
      stripeHasIt: boolean;
    }> = {},
  ) {
    const calls: string[] = [];
    const deps: ApproveAndSubmitDeps = {
      writePendingApproval: async () => {
        calls.push("pending");
        return over.pending ?? "created";
      },
      submittedAtStripe: async () => {
        calls.push("stripe_read");
        return over.stripeHasIt ?? false;
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

  it("a resumed approval Stripe already holds goes straight to confirm, never submitting twice", async () => {
    const { calls, deps } = harness({ pending: "resume", stripeHasIt: true });
    expect((await approveAndSubmit(deps)).status).toBe("submitted");
    expect(calls).toEqual(["pending", "stripe_read", "confirm"]);
  });

  it("a resumed approval Stripe does not hold yet is submitted again", async () => {
    const { calls, deps } = harness({ pending: "resume" });
    expect((await approveAndSubmit(deps)).status).toBe("submitted");
    expect(calls).toEqual(["pending", "stripe_read", "submit", "confirm"]);
  });

  it("an already-confirmed submission is rejected before any Stripe call", async () => {
    const { calls, deps } = harness({ pending: "already_submitted" });
    const result = await approveAndSubmit(deps);
    expect(result.status).toBe("error");
    // Neither submit nor confirm runs: no re-submission of an already-submitted dispute.
    expect(calls).toEqual(["pending"]);
  });
});
