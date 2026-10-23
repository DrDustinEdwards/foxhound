import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { SLACK_WEBHOOK_ERROR } from "~/lib/settings/slack-webhook";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J39 (job_4b5f4ca4e9ae), row S36, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/notifications is Recova's page
// (app/(app)/settings/notifications/page.tsx at blob 93126fd2,
// NotificationsForm.tsx at blob 316c15cf and
// settings/components/NotificationsSection.tsx at blob 494c6dfa, with the
// SaveBar at app/(app)/settings/SaveBar.tsx blob f1d6eb23 and the Toggle at
// components/Toggle.tsx blob 0ebdd395) built from Capsomer 0.9.0's components,
// teal throughout. Recova stays the spec for every field, toggle and label and
// their order; the page keeps the settings layout's 800px column.
//
// The webhook host rule (hooks.slack.com) stays pinned where it was; the
// NULL map and the six columns stay in settings-digest-email-removed and the
// MCP write tests. Every assertion here was seen failing before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/notifications");










// ---------------------------------------------------------------------------
// The loader and the action.
// ---------------------------------------------------------------------------

const ACCOUNT = "acct_1";
let sqlite: Database.Database;

function ctx() {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
          memberships: [{ memberId: "m1", accountId: ACCOUNT, accountName: "Acme", role: "owner" }],
          activeAccountId: ACCOUNT,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

async function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return (await route.action({
    context: ctx(),
    request: new Request("https://x/settings/notifications", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
}

describe("J39 notifications: the loader and the action", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills a NULL notification email with the signed-in email, as Recova does, so the first Save stores it", async () => {
    // Recova's `notification_email ?? user.email`. The box is truthful because
    // Save writes what it shows.
    const loaded = (await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never)) as {
      notificationEmail: string;
    };
    expect(loaded.notificationEmail).toBe("owner@acme.test");
  });

  it("shows a stored notification email as it is", async () => {
    sqlite.prepare("UPDATE accounts SET notification_email = 'ops@acme.test' WHERE id = ?").run(ACCOUNT);
    const loaded = (await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never)) as {
      notificationEmail: string;
    };
    expect(loaded.notificationEmail).toBe("ops@acme.test");
  });

  it("names the webhook field on a refused webhook, so the page can put the error beside it", async () => {
    const res = await post({ notificationEmail: "ops@acme.test", slackWebhookUrl: "https://evil.test/x" });
    expect(res.init?.status).toBe(400);
    expect(res.data).toEqual({ ok: false, error: SLACK_WEBHOOK_ERROR, field: "slackWebhookUrl" });
  });

  it("answers a failed write with Recova's failure state rather than an error page", async () => {
    harness.db = new Proxy(
      {},
      {
        get() {
          throw new Error("D1 unavailable");
        },
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ notificationEmail: "ops@acme.test", digestEnabled: "on" });
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({ ok: false, failed: true });
    // The whole error, stack included, so a D1 failure can be traced in tail.
    const err = logged.mock.calls[0]?.[1];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("D1 unavailable");
  });
});
