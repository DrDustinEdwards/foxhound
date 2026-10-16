import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  buildSuppressionInsert,
  shouldSuppress,
  type EmailServiceEvent,
} from "~/lib/email/events";
import {
  buildClickStamp,
  buildEngagementInsert,
  buildOpenStamp,
} from "~/lib/engagement/record";
import { signEngagementToken, verifyEngagementToken } from "~/lib/engagement/token";

const db = drizzle({} as never, { schema });
const now = new Date("2026-07-12T00:00:00.000Z");
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

// 64 hex chars = 32-byte HMAC key.
const env = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;

describe("engagement token sign/verify", () => {
  it("round-trips a click payload", async () => {
    const token = await signEngagementToken(env, {
      stepId: "step_1",
      accountId: "acc_1",
      kind: "click",
      url: "https://example.com/p/abc",
    });
    const payload = await verifyEngagementToken(env, token);
    expect(payload).toEqual({
      stepId: "step_1",
      accountId: "acc_1",
      kind: "click",
      url: "https://example.com/p/abc",
    });
  });

  it("rejects a tampered token", async () => {
    const token = await signEngagementToken(env, {
      stepId: "step_1",
      accountId: "acc_1",
      kind: "open",
    });
    const [payloadPart, sig] = token.split(".");
    // Flip a byte in the payload; the signature no longer matches.
    const tampered = `${payloadPart.slice(0, -1)}${payloadPart.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    expect(await verifyEngagementToken(env, tampered)).toBeNull();
  });

  it("rejects a garbage token", async () => {
    expect(await verifyEngagementToken(env, "not-a-token")).toBeNull();
  });
});

describe("engagement record builders (compile against schema)", () => {
  it("engagement insert is idempotent on idempotency_key and binds the step + url", () => {
    const sql = sqlOf(
      buildEngagementInsert(db, {
        accountId: "acc_1",
        recoveryStepId: "step_1",
        eventType: "click",
        targetUrl: "https://x/p/1",
        idempotencyKey: "click:step_1",
        occurredAt: now,
      }),
    );
    expect(sql.sql).toMatch(/insert into .*engagement_events/i);
    expect(sql.sql).toMatch(/on conflict.*do nothing/i);
    expect(sql.params).toContain("click:step_1");
    expect(sql.params).toContain("https://x/p/1");
  });

  it("click stamp keeps the first clicked_at (the attribution signal) and counts every click (F10)", () => {
    // Behaviour is proven against a real schema in engagement-click-f10.test.ts;
    // this pins the statement's shape so the first-click rule stays in the SQL.
    const sql = sqlOf(buildClickStamp(db, "step_1", now, null));
    expect(sql.sql).toMatch(/update .*recovery_steps/i);
    expect(sql.sql).toMatch(/"clicked_at" = coalesce\("recovery_steps"\."clicked_at", \?\)/i);
    expect(sql.sql).toMatch(/"email_clicked_count" = coalesce\(/i);
    expect(sql.sql).not.toMatch(/click_suspect_reason/i);
  });

  it("with a suspect reason, the click stamp writes it on the first click only and never clears a mark", () => {
    const sql = sqlOf(buildClickStamp(db, "step_1", now, "too_fast"));
    expect(sql.sql).toMatch(
      /"click_suspect_reason" = case when "recovery_steps"\."clicked_at" is null then \? else "recovery_steps"\."click_suspect_reason" end/i,
    );
    expect(sql.params).toContain("too_fast");
  });

  it("open stamp targets opened_at", () => {
    expect(sqlOf(buildOpenStamp(db, "step_1", now)).sql).toMatch(/opened_at/i);
  });
});

describe("bounce/complaint suppression", () => {
  const evt = (type: string, email = "a@b.com"): EmailServiceEvent => ({
    type,
    email,
    eventId: "ev_1",
  });

  it("suppresses hard bounces and complaints, ignores delivered/opened", () => {
    expect(shouldSuppress(evt("bounce"))).toBe(true);
    expect(shouldSuppress(evt("complaint"))).toBe(true);
    expect(shouldSuppress(evt("delivered"))).toBe(false);
    expect(shouldSuppress(evt("bounce", ""))).toBe(false); // no address
  });

  it("suppression insert records the address, provider event id, and reason", () => {
    const sql = sqlOf(
      buildSuppressionInsert(db, {
        email: "a@b.com",
        token: "ev_1",
        reason: "bounce",
        accountId: "acc_1",
        now,
      }),
    );
    expect(sql.sql).toMatch(/insert into .*email_suppressions/i);
    expect(sql.params).toContain("a@b.com");
    expect(sql.params).toContain("ev_1");
    expect(sql.params).toContain("bounce");
  });
});
