import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J41, row S37, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/stripe is Recova's signed-in page, read whole at HEAD:
//   app/(app)/settings/stripe/page.tsx               blob 338541e6   738 bytes
//   app/(app)/settings/components/StripeSection.tsx  blob 4068961e 4,410 bytes
//   app/api/stripe/disconnect/route.ts               blob 01252285 2,656 bytes
// built from Capsomer 0.9.0's components, amber throughout. Recova is the spec
// for the head, the back link, the one card, each row, the two-step confirm,
// the empty state and Add Stripe account, and for what happens after a
// disconnect (back to /settings) or a failed one (its alert line). Recova's
// id-less POST is not ported: the disconnect names its connection.
//
// Every assertion here was seen failing against the page before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown, deauthorizeOk: true, deauthorizeThrows: false }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/connect", () => ({
  deauthorizeConnectedAccount: async () => {
    // The real function builds its Stripe client outside its own try, so a
    // bad key or config throws here rather than returning { ok: false }.
    if (harness.deauthorizeThrows) throw new Error("STRIPE_SECRET_KEY is not set");
    return harness.deauthorizeOk ? { ok: true } : { ok: false, error: "grant already revoked" };
  },
}));

const route = await import("~/routes/app/settings/stripe");

const SOURCE = readFileSync(new URL("../app/routes/app/settings/stripe.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

interface Conn {
  id: string;
  name: string | null;
  stripeUserId: string;
  connectedAt: Date | null;
}

const ONE: Conn = { id: "c_1", name: "Acme Payments", stripeUserId: "acct_1", connectedAt: new Date("2026-08-21T12:00:00Z") };
const TWO: Conn = { id: "c_2", name: null, stripeUserId: "acct_2", connectedAt: null };

function render(connections: Conn[] = [ONE, TWO], actionData?: Record<string, unknown>): string {
  const loaderData = { connections };
  const Stub = createRoutesStub([
    {
      path: "/settings/stripe",
      Component: () => createElement(Page, { loaderData, actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/stripe"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** Every <a> or <button> whose text is exactly `label`, opening tag and all. */
function controls(html: string, label: string): string[] {
  const all = html.match(/<(a|button)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
  return all.filter((c) => text(c) === label);
}

describe("J41 stripe: the card and its rows", () => {

  it("the first press only asks: the button is never a submit button, so it cannot post on the press that opens the confirm", () => {
    // Found on the rendered page: with `type={isConfirming ? "submit" : "button"}`
    // React re-renders inside the click, before the browser runs the click's
    // default action, so ONE press of "Disconnect Stripe" turned the button
    // into a submit button and then submitted it, disconnecting with no
    // confirm. The button stays type="button" and the second press submits
    // its own form explicitly.
    expect(CODE).not.toMatch(/type=\{isConfirming/);
    expect(CODE).not.toMatch(/<Button[^>]*type="submit"/);
    expect(CODE).toContain(".form?.requestSubmit()");
    for (const b of controls(render(), "Disconnect Stripe")) expect(attr(b, "type")).toBe("button");
  });
});

// ---------------------------------------------------------------------------
// The action, against an in-memory D1.
// ---------------------------------------------------------------------------

const ACTIVE = "acct_active";
let sqlite: Database.Database;

const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: "user_1",
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m1", accountId: ACTIVE, accountName: "Active Co", role: "owner" },
        memberships: [{ memberId: "m1", accountId: ACTIVE, accountName: "Active Co", role: "owner" }],
        activeAccountId: ACTIVE,
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
};

async function post(fields: Record<string, string>): Promise<unknown> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return route.action({
    context: ctx,
    request: new Request("https://foxhoundapp.test/settings/stripe", { method: "POST", body: form }),
    params: {},
  } as never);
}

function seedConnection(id: string, accountId: string): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, 1, 1000, NULL, 1000)",
    )
    .run(id, accountId, "stripe_" + id);
}

function disconnectedAt(id: string): number | null {
  return (sqlite.prepare("SELECT disconnected_at AS d FROM stripe_connections WHERE id = ?").get(id) as { d: number | null }).d;
}

describe("J41 stripe: the action", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    harness.deauthorizeOk = true;
    harness.deauthorizeThrows = false;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, 1000, 0)").run(ACTIVE, "Active Co");
    sqlite.prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, 1000, 0)").run("acct_other", "Other");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a clean disconnect goes back to /settings, as Recova's window.location does", async () => {
    seedConnection("c_mine", ACTIVE);
    const res = (await post({ _action: "disconnect-stripe", connectionId: "c_mine" })) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings");
    expect(disconnectedAt("c_mine")).not.toBeNull();
  });

  it("a revoke that THROWS after the committed batch says the true state: disconnected, with the revoke warning", async () => {
    // Review finding on 8bbe191: the catch wrapped disconnectConnection whole,
    // so a throw from the Stripe revoke, which runs AFTER the batch committed,
    // answered "Could not disconnect Stripe" for a connection that WAS
    // disconnected. The local write stands; only the revoke failed.
    seedConnection("c_mine", ACTIVE);
    harness.deauthorizeThrows = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await post({ _action: "disconnect-stripe", connectionId: "c_mine" })) as {
      data: { ok: boolean; warning?: string; error?: string };
      init?: { status?: number };
    };
    expect(disconnectedAt("c_mine")).not.toBeNull();
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.warning).toBe(
      "Disconnected. Revoking access at Stripe did not complete, so check your Stripe dashboard.",
    );
    // The thrown error is logged whole.
    expect(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "STRIPE_SECRET_KEY is not set" }));
  });

  it("refuses another account's connection with 403 and writes nothing", async () => {
    seedConnection("c_theirs", "acct_other");
    const res = (await post({ _action: "disconnect-stripe", connectionId: "c_theirs" })) as {
      init?: { status?: number };
    };
    expect(res.init?.status).toBe(403);
    expect(disconnectedAt("c_theirs")).toBeNull();
  });

  it("a database failure is logged whole and answered 500, never thrown", async () => {
    seedConnection("c_mine", ACTIVE);
    const boom = new Error("D1 is down");
    const db = harness.db as { select: (...a: unknown[]) => unknown };
    vi.spyOn(db, "select").mockImplementation(() => {
      throw boom;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await post({ _action: "disconnect-stripe", connectionId: "c_mine" })) as {
      data: { ok: boolean; error?: string };
      init?: { status?: number };
    };
    expect(res.init?.status).toBe(500);
    expect(res.data.ok).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.any(String), boom);
    expect(disconnectedAt("c_mine")).toBeNull();
  });
});
