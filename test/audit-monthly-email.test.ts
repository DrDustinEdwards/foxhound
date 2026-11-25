import {
  BASE_URL,
  DAY_SECONDS,
  type EmailResult,
  NOW,
  OCTOBER,
  PERIOD,
  compareTotals,
  driveMonthlyAudit,
  emailFor,
  monthMessage,
  monthly,
  ok,
  renderFoxhoundEmail,
  resultWith,
  seedAccount,
  seedRecovery,
  setup,
  throwingList,
  unread,
} from "./helpers/audit-monthly";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditDigestRuns, auditRuns, emailSends, emailSuppressions } from "~/db/schema";
import { SCOPE_UNREAD } from "~/lib/audit/render";
import { EMAIL_AUTH_SENDER_ADDRESS, EMAIL_FROM_ADDRESS } from "~/lib/constants";

describe("the email's recovery comparison is per currency and never summed across them", () => {
  it("two currencies stay two rows, with their own deltas", () => {
    expect(
      compareTotals(
        [
          { currency: "usd", cents: 800 },
          { currency: "eur", cents: 200 },
        ],
        [
          { currency: "usd", cents: 500 },
          { currency: "eur", cents: 50 },
        ],
      ),
    ).toEqual([
      { currency: "eur", cents: 200, changeCents: 150 },
      { currency: "usd", cents: 800, changeCents: 300 },
    ]);
  });
});

describe("the email never turns an unread scope into a zero", () => {
  it("every failed scope says it could not be read, and the reason stays internal", () => {
    const cases: [Partial<EmailResult>, string[]][] = [
      [
        { disputes: unread("Could not read disputes from Stripe: 500") },
        ["Open disputes", "Disputes accepted without response", "Dispute win rate"],
      ],
      [
        { health: unread("h") },
        ["MRR", "ARR", "Active subs", "Voluntary churn", "Involuntary churn"],
      ],
      [{ failedInvoices: unread("f") }, ["Failed payments detected"]],
      [{ expiringCards: unread("e") }, ["Expiring cards"]],
      [{ pastDueSubscriptions: unread("p") }, ["Past-due subscriptions"]],
    ];
    for (const [over, labels] of cases) {
      const { body } = emailFor({ result: resultWith(over) });
      for (const label of labels) {
        expect(body, `${label} did not say it was unread`).toContain(`${label}: ${SCOPE_UNREAD}`);
      }
      expect(body).not.toContain("Open disputes: 0");
      expect(body).not.toContain("Could not read disputes from Stripe");
    }
    // A scope that did read is unaffected, so this is per scope.
    expect(emailFor({ result: resultWith({ disputes: unread("x") }) }).body).toContain(
      "MRR: $1,000",
    );
  });

  it("escapes what it interpolates, once and never twice", () => {
    // The summary is model-written and the advisory is built from Stripe data.
    const { subject, blocks } = emailFor({
      summary: "Fees & refunds",
      result: resultWith({
        cardUpdater: ok({
          eventsInWindow: 0,
          expiredCardDeclinesInWindow: 3,
          advisory: "A & B",
          windowDays: 30,
        }),
      }),
    });
    const { html } = renderFoxhoundEmail({
      subject,
      blocks,
      brandName: "Foxhound",
      to: "owner@merchant.test",
    });
    expect(html).toContain(">Fees &amp; refunds</td>");
    expect(html).toContain(">Card Updater: A &amp; B</td>");
    expect(html).not.toContain("&amp;amp;");
  });
});

describe("one monthly mail per opted-in account", () => {
  it("goes out on the merchant path: From Foxhound, no Reply-To, no unsubscribe, one real link", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");

    const result = await driveMonthlyAudit(env, NOW, null);

    expect(result.sent).toBe(1);
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.to).toBe("acct_on@merchant.test");
    expect(m.from).toBe(`Foxhound <${EMAIL_FROM_ADDRESS}>`);
    expect(m.from).not.toContain(EMAIL_AUTH_SENDER_ADDRESS);
    expect(m.replyTo).toBeUndefined();
    expect(m.headers).toBeUndefined();
    expect(m.text).not.toContain("Unsubscribe");
    const [run] = await db.select().from(auditRuns);
    expect(m.text).toContain(`View full audit:\n${BASE_URL}/audit/results/${run.id}`);
  });

  it("a failed Stripe read reaches the inbox as a sentence and is stored as NULL", async () => {
    const { db, env, messages } = setup({ disputes: { list: () => throwingList("stripe 500") } });
    await seedAccount(db, "acct_on");

    await driveMonthlyAudit(env, NOW, null);

    expect(messages[0].text).toContain(`Open disputes: ${SCOPE_UNREAD}`);
    expect(messages[0].text).toContain("$42");
    const [stored] = await db.select().from(auditRuns);
    expect(stored.openDisputesCount).toBeNull();
    expect(stored.failedInvoicesCents).toBe(4200);
  });

  it("an account with no notification email is audited but not mailed", async () => {
    const { db, env, delivered } = setup();
    await seedAccount(db, "acct_noemail", { notificationEmail: null });

    const result = await driveMonthlyAudit(env, NOW, null);

    expect(result.skippedNoRecipient).toBe(1);
    expect(delivered).toEqual([]);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_recipient");
    expect(await db.select().from(auditRuns)).toHaveLength(1);
  });

  it("an account with no live connection cannot be audited, and says so", async () => {
    const { db, env, delivered } = setup();
    await seedAccount(db, "acct_noconn", {}, { connect: false });

    const result = await driveMonthlyAudit(env, NOW, null);

    expect(result.skippedNoConnection).toBe(1);
    expect(result.ran).toBe(0);
    expect(delivered).toEqual([]);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_connection");
  });

  it("the same account in a different month is a different slot", async () => {
    const { db, env } = setup();
    await seedAccount(db, "acct_on");

    await driveMonthlyAudit(env, NOW, null);
    expect((await driveMonthlyAudit(env, OCTOBER, null)).sent).toBe(1);

    const rows = await db.select().from(auditDigestRuns);
    expect(rows.map((r) => r.periodMonth).sort()).toEqual(["2026-08", "2026-09"]);
  });

  it("month two reports the change since month one", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");
    await seedRecovery(db, "acct_on", 5_00);

    await driveMonthlyAudit(env, NOW, null);
    await seedRecovery(db, "acct_on", 3_00);
    await driveMonthlyAudit(env, OCTOBER, null);

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain("$5.00");
    expect(messages[1].text).toContain("$8.00"); // cumulative
    expect(messages[1].text).toContain("up $3.00"); // the month's change
  });

  it("only billable attribution counts, so a stripe_baseline row is not claimed", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");
    await seedRecovery(db, "acct_on", 900, "stripe_baseline");

    await driveMonthlyAudit(env, NOW, null);

    expect(messages[0].text).not.toContain("$9.00");
  });

  for (const days of [30, 180]) {
    it(`a stored ${days}-day lookback asks Stripe for ${days} days and is stored on the run`, async () => {
      const { db, env, stripeCalls } = setup();
      await seedAccount(db, "acct_lookback", { auditLookbackDays: days });

      const result = await driveMonthlyAudit(env, NOW, null);

      const uncollectible = stripeCalls.invoiceParams.find((p) => p.status === "uncollectible");
      expect(uncollectible?.created).toEqual({
        gte: Math.floor(NOW.getTime() / 1000) - days * DAY_SECONDS,
      });
      expect(result.ran).toBe(1);
      expect((await db.select().from(auditRuns))[0].lookbackDays).toBe(days);
    });
  }
});

describe("a refused send returns its named outcome", () => {
  it("a suppressed address is not mailed, and the month says suppressed", async () => {
    const { db, env, delivered } = setup();
    await seedAccount(db, "acct_on");
    await db.insert(emailSuppressions).values({
      id: "sup_1",
      email: "acct_on@merchant.test",
      token: "t",
      suppressedAt: NOW,
      reason: "bounce",
    });

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("acct_on"), NOW);

    expect(outcome.status).toBe("suppressed");
    expect(delivered).toHaveLength(0);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("suppressed");
    expect(await db.select().from(auditRuns)).toHaveLength(1);
  });

  it("a standing send claim for the month is already_sent: nothing is mailed again", async () => {
    // The outcome of the earlier send is unknown, so the retry must not mail a second time.
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");
    await db.insert(emailSends).values({
      id: "es_planted",
      idempotencyKey: `monthly-audit:acct_on:${PERIOD}`,
      accountId: "acct_on",
      template: "monthly_audit",
      status: "pending",
      error: null,
      createdAt: NOW,
    });
    await db.insert(auditDigestRuns).values({
      id: "month_planted",
      accountId: "acct_on",
      periodMonth: PERIOD,
      totals: null,
      status: "failed",
      error: "earlier",
      sentAt: null,
      cronRunId: null,
      createdAt: NOW,
    });

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("acct_on"), NOW);

    expect(outcome.status).toBe("already_sent");
    expect(messages).toHaveLength(0);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("already_sent");
  });

  it("a provider failure is failed, with the provider's words, and the next delivery sends once", async () => {
    const { db, env, failFor, delivered } = setup();
    await seedAccount(db, "acct_on");
    failFor.add("acct_on@merchant.test");

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("acct_on"), NOW);
    expect(outcome.status).toBe("failed");
    expect((outcome.error as Error).message).toContain("mailbox full");
    expect((await db.select().from(auditDigestRuns))[0]).toMatchObject({ status: "failed" });

    failFor.clear();
    const action = await monthly.processMonthlyAuditMessage(env, monthMessage("acct_on"), 2, NOW);
    expect(action).toBe("ack");
    expect(delivered).toEqual(["acct_on@merchant.test"]);
  });
});

describe("the demo firewall", () => {
  it("a demo account delivered straight to the consumer is not_eligible: no audit, no mail", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "demo_teamflow");

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("demo_teamflow"), NOW);

    expect(outcome).toEqual({ status: "not_eligible", ran: false });
    expect(messages).toHaveLength(0);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
    expect(await db.select().from(emailSends)).toHaveLength(0);
  });

  it('only the monthly audit and the team invite skip the live-send gate: liveSendGate: "skip" appears nowhere else under app/', () => {
    const root = fileURLToPath(new URL("../app", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else if (
          /\.tsx?$/.test(entry) &&
          /liveSendGate:\s*"skip"/.test(readFileSync(full, "utf8"))
        ) {
          hits.push(full.slice(full.indexOf("app/")));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual([
      "app/lib/audit/monthly.server.ts",
      "app/lib/settings/team-invite-email.server.ts",
    ]);
  });
});
