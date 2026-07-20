import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  approvalRaceErrorMessage,
  buildApprovalBatch,
  canApprove,
  hashEvidence,
  planApproveAndSubmit,
} from "~/lib/disputes/approval";

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

describe("buildApprovalBatch (compiles against schema)", () => {
  it("advances the dispute to submitted and writes the approval row in one batch, guarded by state", () => {
    const batch = buildApprovalBatch(db, {
      disputeId: "dsp_1",
      accountId: "acc_1",
      approvedByUserId: "user_1",
      approvedByEmail: "owner@example.com",
      evidenceVersionHash: "abc123",
      approvedAt: now,
    });
    // Submission requires an approval row: both statements ride the same
    // batch, so there is no way to reach one without the other.
    expect(batch.length).toBe(2);

    const stateAdvance = sqlOf(batch[0]);
    expect(stateAdvance.sql).toMatch(/update .*disputes/i);
    expect(stateAdvance.sql).toMatch(/not in/i);
    expect(stateAdvance.params).toContain("submitted");
    expect(stateAdvance.params).toContain("dsp_1");

    const approvalInsert = sqlOf(batch[1]);
    expect(approvalInsert.sql).toMatch(/insert into .*dispute_approvals/i);
    expect(approvalInsert.params).toContain("abc123");
    expect(approvalInsert.params).toContain("dsp_1");
  });
});

describe("planApproveAndSubmit (PRICING.md hard rule: no submission without approval)", () => {
  const baseInput = {
    disputeId: "dsp_1",
    accountId: "acc_1",
    approvedByUserId: "user_1",
    approvedByEmail: "owner@example.com",
    stripeDisputeId: "dp_1",
    evidence: [{ fieldName: "product_description", fieldValue: "Widget" }],
    connectionAccessToken: "iv:cipher",
    approvedAt: now,
  };

  it("never builds an approval batch when Stripe submission fails: the structural proof", async () => {
    let submitCalls = 0;
    const result = await planApproveAndSubmit(db, baseInput, {
      submit: async () => {
        submitCalls += 1;
        return { ok: false, error: "card issuer declined the request" };
      },
    });
    expect(submitCalls).toBe(1);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("card issuer declined the request");
    }
    // No `batch` property at all on an error result: there is nothing a
    // caller could accidentally commit.
    expect("batch" in result).toBe(false);
  });

  it("builds the approval batch only after a successful submission", async () => {
    const submitted: unknown[] = [];
    const result = await planApproveAndSubmit(db, baseInput, {
      submit: async (ctx) => {
        submitted.push(ctx);
        return { ok: true };
      },
    });
    expect(submitted).toHaveLength(1);
    expect(result.status).toBe("submitted");
    if (result.status === "submitted") {
      expect(result.batch.length).toBe(2);
      expect(sqlOf(result.batch[0]).sql).toMatch(/update .*disputes/i);
      expect(sqlOf(result.batch[1]).sql).toMatch(/insert into .*dispute_approvals/i);
    }
  });

  it("errors without ever calling submit when there is no connected Stripe account", async () => {
    let submitCalls = 0;
    const result = await planApproveAndSubmit(
      db,
      { ...baseInput, connectionAccessToken: null },
      { submit: async () => { submitCalls += 1; return { ok: true }; } },
    );
    expect(submitCalls).toBe(0);
    expect(result.status).toBe("error");
  });

  it("passes only the merchant-approved evidence package, not arbitrary data, to Stripe", async () => {
    const seen: { evidence: Record<string, unknown> }[] = [];
    await planApproveAndSubmit(
      db,
      {
        ...baseInput,
        evidence: [
          { fieldName: "product_description", fieldValue: "Widget" },
          { fieldName: "not_a_real_stripe_field", fieldValue: "should be dropped" },
        ],
      },
      {
        submit: async (ctx) => {
          seen.push(ctx as unknown as { evidence: Record<string, unknown> });
          return { ok: true };
        },
      },
    );
    expect(seen[0].evidence).toEqual({ product_description: "Widget" });
  });
});
