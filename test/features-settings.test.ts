import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 57: S34's features page.
//
// THE TWO TOGGLES SESSIONS 52 AND 49 BUILT THEIR CRONS AGAINST, and this is
// their writer. Both are NULL-is-ON and BOTH ENDS AGREE: legacy renders `?? true`
// and both crons skip on `=== false`.
//
// IT UN-GATES NOTHING ELSE. 176 claims these toggles free S2's disputes state
// and S6's Intelligence entry; legacy's own SiteNav.tsx:110-119 gates the
// product switcher on `account_products`, and Foxhound's equivalent is
// `isIntelligenceEntitled` over `account_subscriptions`. Both are asserted
// below to be untouched by a save here.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  emailJobs: [] as Record<string, unknown>[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/email/dispatch", () => ({
  processEmailJob: async (_env: unknown, job: Record<string, unknown>) => {
    harness.emailJobs.push(job);
    return { status: "sent" };
  },
}));

const { buildFeatureSettingsUpdate } = await import("~/lib/settings/persist.server");
const { runWinbackSends } = await import("~/lib/cron/winback");
const { sendExpiringCardAlerts } = await import("~/lib/cron/expiring-cards");
const featuresRoute = await import("~/routes/app/settings/features");

const ACCOUNT = "acct_1";
const NOW = new Date("2026-11-02T12:00:00Z");
const DUE = new Date("2026-11-02T11:00:00Z");
const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way",
} as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

/** The route's own context, so the plants below drive the PAGE rather than the
 *  builder underneath it. Three mutations stayed green until they did. */
function routeContext(accountId = ACCOUNT) {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) return { email: "owner@acme.test", membership: { accountId } };
      throw new Error("unexpected context key");
    },
  } as never;
}

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.emailJobs = [];
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, 0, 1)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, sender_name, connected_at, created_at) VALUES ('c1', ?, 'acct_s', 1, 'cipher', 'Teamflow', 1000, 1000)",
    )
    .run(ACCOUNT);
});

function toggles() {
  return sqlite
    .prepare(
      "SELECT winback_notifications_enabled AS winback, expiring_card_notifications_enabled AS expiring, digest_enabled AS digest, slack_notifications_enabled AS slack, recovery_notifications_enabled AS recovery FROM accounts WHERE id = ?",
    )
    .get(ACCOUNT) as Record<string, unknown>;
}

async function save(winback: boolean, expiring: boolean): Promise<void> {
  await buildFeatureSettingsUpdate(db, ACCOUNT, {
    winbackNotificationsEnabled: winback,
    expiringCardNotificationsEnabled: expiring,
  });
}

function seedWinbackStep(): void {
  sqlite
    .prepare(
      "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, plan_name, amount_cents, currency, status, created_at, stripe_connection_id) VALUES ('wb_1', ?, 'cus_1', 'sub_1', 'b@a.test', 'Pro', 4900, 'usd', 'active', 1000, 'c1')",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO win_back_steps (id, win_back_sequence_id, account_id, step_number, scheduled_at, attempt_count) VALUES ('st_1', 'wb_1', ?, 1, ?, 0)",
    )
    .run(ACCOUNT, DUE.getTime());
}

function seedExpiringAlert(): void {
  sqlite
    .prepare(
      "INSERT INTO expiring_card_alerts (id, account_id, stripe_customer_id, customer_email, expires_month, expires_year, created_at, stripe_connection_id) VALUES ('al_1', ?, 'cus_1', 'b@a.test', 12, 2026, 1000, 'c1')",
    )
    .run(ACCOUNT);
}

function stepResult(): string | null {
  return (
    sqlite.prepare("SELECT result FROM win_back_steps WHERE id = 'st_1'").get() as
      | { result: string | null }
      | undefined
  )?.result ?? null;
}

describe("PLANT 1: NULL renders ON, and both ends agree", () => {
  it("an untouched account has both columns NULL", () => {
    const row = toggles();
    expect(row.winback).toBeNull();
    expect(row.expiring).toBeNull();
  });

  it("NULL SENDS: the win-back cron does not skip an untouched account", async () => {
    seedWinbackStep();

    const result = await runWinbackSends(env, NOW);

    expect(result.sent).toBe(1);
    expect(stepResult()).toBe("email_sent_fallback");
  });

  it("NULL SENDS: the expiring-card cron does not skip one either", async () => {
    seedExpiringAlert();

    const result = await sendExpiringCardAlerts(env, NOW);

    expect(result.sent).toBe(1);
  });
});

describe("PLANT 2: the save writes its two columns and only those", () => {
  it("both on", async () => {
    await save(true, true);
    const row = toggles();
    expect(row.winback).toBe(1);
    expect(row.expiring).toBe(1);
  });

  it("both off", async () => {
    await save(false, false);
    const row = toggles();
    expect(row.winback).toBe(0);
    expect(row.expiring).toBe(0);
  });

  it("each column moves independently of the other", async () => {
    await save(false, true);
    expect(toggles().winback).toBe(0);
    expect(toggles().expiring).toBe(1);
  });

  it("AND WRITES NO S36 COLUMN, because those are a different page", async () => {
    sqlite
      .prepare(
        "UPDATE accounts SET digest_enabled = 1, slack_notifications_enabled = 1, recovery_notifications_enabled = 0 WHERE id = ?",
      )
      .run(ACCOUNT);

    await save(false, false);

    const row = toggles();
    expect(row.digest).toBe(1);
    expect(row.slack).toBe(1);
    expect(row.recovery).toBe(0);
  });
});

describe("PLANT 3: OFF skips each cron, reached alone", () => {
  it("win-back OFF stamps the step and sends nothing", async () => {
    seedWinbackStep();
    await save(false, true);

    const result = await runWinbackSends(env, NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(harness.emailJobs).toEqual([]);
    expect(stepResult()).toBe("skipped_notifications_disabled");
  });

  it("expiring-card OFF stamps the alert and sends nothing", async () => {
    seedExpiringAlert();
    await save(true, false);

    const result = await sendExpiringCardAlerts(env, NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(harness.emailJobs).toEqual([]);
  });

  it("EACH TOGGLE GATES ONLY ITS OWN CRON", async () => {
    // Win-back off, expiring-card on: the alert must still go out. This is what
    // makes the two independent rather than one feature flag.
    seedWinbackStep();
    seedExpiringAlert();
    await save(false, true);

    expect((await runWinbackSends(env, NOW)).sent).toBe(0);
    expect((await sendExpiringCardAlerts(env, NOW)).sent).toBe(1);
  });

  it("and the other way round", async () => {
    seedWinbackStep();
    seedExpiringAlert();
    await save(true, false);

    expect((await runWinbackSends(env, NOW)).sent).toBe(1);
    expect((await sendExpiringCardAlerts(env, NOW)).sent).toBe(0);
  });

  it("turning it back ON sends again", async () => {
    seedWinbackStep();
    await save(true, true);

    expect((await runWinbackSends(env, NOW)).sent).toBe(1);
  });
});

describe("PLANT 4: the page un-gates nothing else, which is 176 disproven", () => {
  it("a save leaves account_subscriptions untouched, which is what S6 reads", async () => {
    const before = sqlite.prepare("SELECT count(*) AS n FROM account_subscriptions").get();

    await save(false, false);

    expect(sqlite.prepare("SELECT count(*) AS n FROM account_subscriptions").get()).toEqual(before);
  });

  it("THE PAGE'S CODE NAMES NEITHER GATE TABLE, comments stripped first", async () => {
    // The header comment DISCUSSES account_products at length, explaining that
    // legacy's page never touches it, so a raw grep would fail on the
    // explanation rather than on the code. Strip comments and assert what the
    // module actually does.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("app/routes/app/settings/features.tsx", "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(code).toContain("buildFeatureSettingsUpdate");
    expect(code).not.toContain("account_products");
    expect(code).not.toContain("accountSubscriptions");
    expect(code).not.toContain("isIntelligenceEntitled");
  });
});

describe("PLANT 5: the docs say the toggles exist", () => {
  it("both engine sections name the features page", async () => {
    const { DOC_GUIDES } = await import("~/lib/marketing/docs-content");
    const body = DOC_GUIDES.flatMap((g) => g.sections)
      .flatMap((s) => s.body)
      .join(" ");

    expect(body).toContain(
      "Expiring card alerts are on unless you turn them off on the features page",
    );
    expect(body).toContain(
      "Win-back sequences are on unless you turn them off on the features page",
    );
  });
});

describe("PLANT 6: the PAGE itself, loader and action", () => {
  it("THE LOADER RENDERS NULL AS ON, which the builder plants never reached", async () => {
    const result = (await featuresRoute.loader({ context: routeContext() } as never)) as {
      winbackNotificationsEnabled: boolean;
      expiringCardNotificationsEnabled: boolean;
    };

    expect(result.winbackNotificationsEnabled).toBe(true);
    expect(result.expiringCardNotificationsEnabled).toBe(true);
  });

  it("and renders a stored false as off", async () => {
    await save(false, false);

    const result = (await featuresRoute.loader({ context: routeContext() } as never)) as {
      winbackNotificationsEnabled: boolean;
      expiringCardNotificationsEnabled: boolean;
    };

    expect(result.winbackNotificationsEnabled).toBe(false);
    expect(result.expiringCardNotificationsEnabled).toBe(false);
  });

  it("THE ACTION MAPS EACH FIELD TO ITS OWN COLUMN, not one to both", async () => {
    // A checkbox posts its name only when checked, so this form turns win-back
    // ON and leaves expiring-card OFF.
    const form = new FormData();
    form.set("winbackNotificationsEnabled", "on");

    await featuresRoute.action({
      context: routeContext(),
      request: new Request("https://foxhoundapp.test/settings/features", {
        method: "POST",
        body: form,
      }),
    } as never);

    expect(toggles().winback).toBe(1);
    expect(toggles().expiring).toBe(0);
  });

  it("and the other field alone, so neither name is wired to both", async () => {
    const form = new FormData();
    form.set("expiringCardNotificationsEnabled", "on");

    await featuresRoute.action({
      context: routeContext(),
      request: new Request("https://foxhoundapp.test/settings/features", {
        method: "POST",
        body: form,
      }),
    } as never);

    expect(toggles().winback).toBe(0);
    expect(toggles().expiring).toBe(1);
  });

  it("AN EMPTY FORM TURNS BOTH OFF, because an absent checkbox is off", async () => {
    await save(true, true);

    await featuresRoute.action({
      context: routeContext(),
      request: new Request("https://foxhoundapp.test/settings/features", {
        method: "POST",
        body: new FormData(),
      }),
    } as never);

    expect(toggles().winback).toBe(0);
    expect(toggles().expiring).toBe(0);
  });
});

describe("PLANT 7: the write is pinned to its own account", () => {
  it("A SAVE ON ONE ACCOUNT LEAVES ANOTHER UNTOUCHED", async () => {
    // With one account in the fixture an unpinned UPDATE hits the same row and
    // proves nothing, which is exactly what happened on the first pass.
    sqlite
      .prepare(
        "INSERT INTO accounts (id, name, created_at, processing_paused, winback_notifications_enabled, expiring_card_notifications_enabled) VALUES ('acct_2', 'Other', 1000, 0, 1, 1)",
      )
      .run();

    await save(false, false);

    const other = sqlite
      .prepare(
        "SELECT winback_notifications_enabled AS winback, expiring_card_notifications_enabled AS expiring FROM accounts WHERE id = 'acct_2'",
      )
      .get() as Record<string, unknown>;
    expect(other.winback).toBe(1);
    expect(other.expiring).toBe(1);
  });
});
