import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A disconnect decides whether a merchant's Stripe account keeps feeding the
// recovery engine, so every refusing branch is asserted to have written nothing.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  deauthorizeThrows: false,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/connect", () => ({
  deauthorizeConnectedAccount: async () => {
    // The real function builds its Stripe client outside its own try, so a bad
    // key or config throws here rather than returning { ok: false }.
    if (harness.deauthorizeThrows) throw new Error("STRIPE_SECRET_KEY is not set");
    return { ok: true };
  },
}));

const { action, loader } = await import("~/routes/app/settings/stripe");

const ACTIVE = "acct_active";
const OTHER = "acct_other";

let sqlite: Database.Database;

function ctxFor(role = "owner") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m1", accountId: ACTIVE, accountName: "Active Co", role },
          memberships: [{ memberId: "m1", accountId: ACTIVE, accountName: "Active Co", role }],
          activeAccountId: ACTIVE,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function post(fields: Record<string, string>, role = "owner"): Promise<unknown> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return action({
    context: ctxFor(role),
    request: new Request("https://foxhoundapp.test/settings/stripe", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);
}

type Answer = { data: { ok: boolean; warning?: string }; init?: { status?: number } };

function seedConnection(id: string, accountId: string): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, 1, 1000, NULL, 1000)",
    )
    .run(id, accountId, "stripe_" + id);
}

function disconnectedAt(id: string): number | null {
  return (
    sqlite.prepare("SELECT disconnected_at AS d FROM stripe_connections WHERE id = ?").get(id) as {
      d: number | null;
    }
  ).d;
}

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.deauthorizeThrows = false;
  for (const [id, name] of [
    [ACTIVE, "Active Co"],
    [OTHER, "Other"],
  ]) {
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, 1000, 0)")
      .run(id, name);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stripe disconnect", () => {
  it("disconnects the named connection and goes back to /settings, leaving the account none live", async () => {
    seedConnection("c_mine", ACTIVE);
    const res = (await post({ _action: "disconnect-stripe", connectionId: "c_mine" })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings");
    expect(disconnectedAt("c_mine")).not.toBeNull();

    const loaded = (await loader({
      context: ctxFor(),
      request: new Request("https://x/settings/stripe"),
      params: {},
    } as never)) as { connections: unknown[] };
    expect(loaded.connections).toEqual([]);
  });

  it("refuses a missing id, a member, and another account's connection, and writes nothing", async () => {
    seedConnection("c_mine", ACTIVE);
    seedConnection("c_theirs", OTHER);

    const noId = (await post({ _action: "disconnect-stripe" })) as Answer;
    expect(noId.init?.status).toBe(400);
    const member = (await post(
      { _action: "disconnect-stripe", connectionId: "c_mine" },
      "member",
    )) as Answer;
    expect(member.init?.status).toBe(403);
    const theirs = (await post({
      _action: "disconnect-stripe",
      connectionId: "c_theirs",
    })) as Answer;
    expect(theirs.init?.status).toBe(403);

    expect(disconnectedAt("c_mine")).toBeNull();
    expect(disconnectedAt("c_theirs")).toBeNull();
  });

  it("a revoke that throws after the commit says the true state: disconnected, with a warning", async () => {
    // The local write stands; only Stripe's revoke failed.
    seedConnection("c_mine", ACTIVE);
    harness.deauthorizeThrows = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await post({ _action: "disconnect-stripe", connectionId: "c_mine" })) as Answer;
    expect(disconnectedAt("c_mine")).not.toBeNull();
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.warning).toContain("Revoking access at Stripe did not complete");
  });

  // One press of "Disconnect Stripe" once disconnected with no confirm: React
  // re-rendered a submit-typed button inside the click, so the same press
  // submitted it. The button stays type="button" and the second press submits
  // its form explicitly.
  it("the first press only asks: the confirm button never turns into a submit button", () => {
    const code = readFileSync(
      new URL("../app/routes/app/settings/stripe.tsx", import.meta.url),
      "utf8",
    );
    expect(code).not.toMatch(/type=\{isConfirming/);
    expect(code).toContain(".form?.requestSubmit()");
  });
});
