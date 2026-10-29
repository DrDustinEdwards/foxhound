import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { emailSends, emailSuppressions } from "~/db/schema";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { recordEmailEvent } from "~/lib/email/events";
import { getDeliverabilityCounts } from "~/lib/recovery/dashboard-queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Parity gap 9. Recova attributed a bounce or complaint to its merchant by the
// provider message id (recova app/api/webhooks/resend/route.ts, R-13). Here the
// Email Sending event's payload.messageId finds the email_sends row and its
// account, so the account's deliverability panel counts the event; an event
// whose message id matches no send keeps account_id null.

const now = new Date("2026-07-20T12:00:00.000Z");

const envelope = (kind: "bounced" | "complained", messageId: string, recipient: string) => ({
  type: `cf.email.sending.message.${kind}`,
  source: { type: "email.sending", zoneId: "z", domain: "send.example.com" },
  payload: {
    eventId: `ev_${recipient}`,
    messageId,
    recipient,
    ...(kind === "bounced" ? { bounce: { type: "hard", reason: "550 5.1.1 User unknown" } } : {}),
  },
});

describe("deliverability events are attributed to the send's account", () => {
  it("links by message id, counts on the account's panel, and leaves unmatched events null", async () => {
    const { db } = createInMemoryDb();
    await seedDemoAccount(db, now);
    await db.delete(emailSuppressions).where(eq(emailSuppressions.accountId, DEMO_ACCOUNT_ID));
    const before = await getDeliverabilityCounts(db, DEMO_ACCOUNT_ID, null);

    await db.insert(emailSends).values([
      { accountId: DEMO_ACCOUNT_ID, status: "sent", providerMessageId: "msg_bounce", sentAt: now, createdAt: now },
      { accountId: DEMO_ACCOUNT_ID, status: "sent", providerMessageId: "msg_spam", sentAt: now, createdAt: now },
    ]);

    expect(await recordEmailEvent(db, envelope("bounced", "msg_bounce", "gone@example.com"), now)).toBe("suppressed");
    expect(await recordEmailEvent(db, envelope("complained", "msg_spam", "angry@example.com"), now)).toBe("suppressed");
    expect(await recordEmailEvent(db, envelope("bounced", "msg_unknown", "stray@example.com"), now)).toBe("suppressed");

    const rows = await db
      .select({ email: emailSuppressions.email, accountId: emailSuppressions.accountId, reason: emailSuppressions.reason })
      .from(emailSuppressions);
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(byEmail["gone@example.com"]).toEqual({ email: "gone@example.com", accountId: DEMO_ACCOUNT_ID, reason: "hard_bounce" });
    expect(byEmail["angry@example.com"]).toEqual({ email: "angry@example.com", accountId: DEMO_ACCOUNT_ID, reason: "complaint" });
    expect(byEmail["stray@example.com"]?.accountId).toBeNull();

    const after = await getDeliverabilityCounts(db, DEMO_ACCOUNT_ID, null);
    expect(after.bounced).toBe(before.bounced + 1);
    expect(after.complaints).toBe(before.complaints + 1);
  });
});
