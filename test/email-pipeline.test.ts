import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildEmailSendRow } from "~/lib/email/dispatch";
import { buildEmailMessage } from "~/lib/email/send";
import type { EmailJob } from "~/lib/email/types";

const db = drizzle({} as never, { schema });
const now = new Date("2026-07-12T00:00:00.000Z");

function job(overrides: Partial<EmailJob> = {}): EmailJob {
  return {
    accountId: "acc_1",
    recoveryStepId: "step_1",
    to: "customer@example.com",
    fromName: "Acme",
    subject: "Your payment needs a quick fix",
    bodyHtml: "<p>Please update your card.</p>",
    template: "recovery_dunning",
    unsubscribeToken: "unsub_tok",
    physicalAddress: "123 Main St, Springfield",
    idempotencyKey: "step_1",
    ...overrides,
  };
}

describe("buildEmailMessage (CAN-SPAM + from)", () => {
  it("appends an unsubscribe link and the physical address, and sets the List-Unsubscribe header", () => {
    const msg = buildEmailMessage(job(), "https://foxhound.example");
    expect(msg.from).toBe("Acme <recovery@send.foxhoundapp.com>");
    expect(msg.html).toContain("<p>Please update your card.</p>");
    expect(msg.html).toContain("https://foxhound.example/u/unsub_tok");
    expect(msg.html).toContain("123 Main St, Springfield");
    expect(msg.headers?.["List-Unsubscribe"]).toBe("<https://foxhound.example/u/unsub_tok>");
    expect(msg.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("falls back to a default sender name when none is given", () => {
    expect(buildEmailMessage(job({ fromName: null }), "https://x").from).toBe(
      "Billing <recovery@send.foxhoundapp.com>",
    );
  });

  it("throws (never sends) when the physical address is missing", () => {
    expect(() => buildEmailMessage(job({ physicalAddress: "" }), "https://x")).toThrow(
      /physical address/i,
    );
  });

  it("throws (never sends) when the unsubscribe token is missing", () => {
    expect(() => buildEmailMessage(job({ unsubscribeToken: "" }), "https://x")).toThrow(
      /unsubscribe/i,
    );
  });

  it("escapes HTML in the physical address so the footer can't be broken out of", () => {
    const msg = buildEmailMessage(job({ physicalAddress: '<script>"x"' }), "https://x");
    expect(msg.html).toContain("&lt;script&gt;&quot;x&quot;");
    expect(msg.html).not.toContain("<script>");
  });
});

describe("buildEmailSendRow (compile against schema)", () => {
  it("logs a sent row with sent_at and a recipient hash, never the raw address", () => {
    const stmt = buildEmailSendRow(db, {
      job: job(),
      status: "sent",
      providerMessageId: "prov_1",
      error: null,
      recipientHash: "deadbeef",
      queueMessageId: "q_1",
      now,
    });
    const sql = (stmt as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
    expect(sql.sql).toMatch(/insert into .*email_sends/i);
    expect(sql.params).toContain("deadbeef");
    expect(sql.params).toContain("sent");
    expect(sql.params).not.toContain("customer@example.com");
  });

  it("logs a suppressed row with no sent_at", () => {
    const stmt = buildEmailSendRow(db, {
      job: job(),
      status: "suppressed",
      providerMessageId: null,
      error: null,
      recipientHash: "deadbeef",
      queueMessageId: null,
      now,
    });
    const sql = (stmt as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
    expect(sql.params).toContain("suppressed");
  });
});
