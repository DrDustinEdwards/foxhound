import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { formatCentsAsDollars, parseDollarsToCents } from "~/lib/settings/dollars";
import {
  buildAccountProfileUpdate,
  buildBrandVoiceUpdate,
  buildEmailSettingsUpdate,
  buildIntelligenceContextUpdate,
  buildNotificationSettingsUpdate,
} from "~/lib/settings/persist.server";

const db = drizzle({} as never, { schema });

function sqlOf(item: unknown): { sql: string; params: unknown[] } {
  return (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

describe("settings persistence builders (compile against schema)", () => {
  it("account profile update targets accounts.name, scoped by id", () => {
    const { sql, params } = sqlOf(buildAccountProfileUpdate(db, "acc_1", { name: "Acme" }));
    expect(sql).toMatch(/update .*accounts/i);
    expect(params).toContain("Acme");
    expect(params).toContain("acc_1");
  });

  it("email settings update writes notification_email and NOT digest_email", () => {
    // digest_email was removed under 336 binding 3: a Foxhound invention with
    // no legacy counterpart and no reader. This assertion moved from requiring
    // the column to forbidding it, because the behavior was corrected.
    const { sql, params } = sqlOf(
      buildEmailSettingsUpdate(db, "acc_1", { notificationEmail: "ops@acme.com" }),
    );
    expect(sql).toMatch(/update .*accounts/i);
    expect(sql).toMatch(/notification_email/);
    expect(sql).not.toMatch(/digest_email/);
    expect(params).toContain("ops@acme.com");
    expect(params).toContain("acc_1");
  });

  it("notification settings update writes the SIX controls legacy's page renders", () => {
    const { sql, params } = sqlOf(
      buildNotificationSettingsUpdate(db, "acc_1", {
        notificationEmail: "ops@acme.com",
        slackWebhookUrl: "https://hooks.slack.com/x",
        slackNotificationsEnabled: false,
        digestEnabled: true,
        recoveryNotificationsEnabled: true,
        sequenceCompleteNotificationsEnabled: true,
      }),
    );
    expect(sql).toMatch(/update .*accounts/i);
    expect(sql).toMatch(/notification_email/);
    expect(sql).toMatch(/slack_webhook_url/);
    expect(sql).toMatch(/slack_notifications_enabled/);
    expect(sql).toMatch(/digest_enabled/);
    expect(sql).toMatch(/recovery_notifications_enabled/);
    expect(sql).toMatch(/sequence_complete_notifications_enabled/);
    expect(params).toContain("https://hooks.slack.com/x");
    expect(params).toContain("acc_1");
  });

  it("AND WRITES NEITHER S34 COLUMN, which legacy renders on a different page", () => {
    // 336's reversal: the docs say six toggles, legacy's component has four,
    // and win-back and expiring-card live on the features page. A builder that
    // wrote them from here would be a page silently setting columns it never
    // shows.
    const { sql } = sqlOf(
      buildNotificationSettingsUpdate(db, "acc_1", {
        notificationEmail: null,
        slackWebhookUrl: null,
        slackNotificationsEnabled: false,
        digestEnabled: false,
        recoveryNotificationsEnabled: true,
        sequenceCompleteNotificationsEnabled: true,
      }),
    );
    expect(sql).not.toMatch(/winback_notifications_enabled/);
    expect(sql).not.toMatch(/expiring_card_notifications_enabled/);
  });

  it("intelligence context update writes industry, customer type, and self-reported MRR in cents", () => {
    const { sql, params } = sqlOf(
      buildIntelligenceContextUpdate(db, "acc_1", {
        merchantIndustry: "SaaS",
        primaryCustomerType: "B2B",
        merchantMrrSelfReportedCents: 500_000,
      }),
    );
    expect(sql).toMatch(/update .*accounts/i);
    expect(sql).toMatch(/merchant_industry/);
    expect(sql).toMatch(/primary_customer_type/);
    expect(sql).toMatch(/merchant_mrr_self_reported/);
    expect(params).toContain("SaaS");
    expect(params).toContain("B2B");
    expect(params).toContain(500_000);
  });

  it("brand voice update targets stripe_connections scoped by BOTH connection id AND account id", () => {
    // Account-scoping audit CRITICAL #1: the connectionId is client-supplied, so
    // the WHERE must also pin account_id or a merchant could overwrite another's
    // brand voice (which feeds their live dunning-email tone).
    const { sql, params } = sqlOf(buildBrandVoiceUpdate(db, "acc_1", "conn_1", "Warm and direct"));
    expect(sql).toMatch(/update .*stripe_connections/i);
    expect(sql).toMatch(/brand_voice/);
    expect(sql).toMatch(/account_id/); // the tenant guard is in the query itself
    expect(params).toContain("Warm and direct");
    expect(params).toContain("conn_1");
    expect(params).toContain("acc_1");
  });

  it("brand voice update can clear the field back to null", () => {
    const { params } = sqlOf(buildBrandVoiceUpdate(db, "acc_1", "conn_1", null));
    expect(params).toContain(null);
  });
});

describe("parseDollarsToCents / formatCentsAsDollars (round trip)", () => {

  it("strips thousands separators", () => {
    expect(parseDollarsToCents("5,000")).toBe(500_000);
  });

  it("blank or invalid input clears the field (null)", () => {
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("   ")).toBeNull();
    expect(parseDollarsToCents("not a number")).toBeNull();
    expect(parseDollarsToCents("-100")).toBeNull();
  });

  it("round-trips through formatCentsAsDollars", () => {
    const cents = parseDollarsToCents("1234.50");
    expect(formatCentsAsDollars(cents)).toBe("1234.50");
  });

  it("formats null as an empty string", () => {
    expect(formatCentsAsDollars(null)).toBe("");
  });
});
