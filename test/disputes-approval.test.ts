import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildApprovalBatch, canApprove, hashEvidence } from "~/lib/disputes/approval";

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
