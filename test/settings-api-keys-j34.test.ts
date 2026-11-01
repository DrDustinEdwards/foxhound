import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J34, row S29, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/api-keys is Recova's page
// (app/(app)/settings/api-keys/page.tsx at blob b50fb228 and ApiKeysClient.tsx
// at blob 338db3db, with its API at app/api/settings/api-keys/route.ts, blob
// 81e694f5) built from Capsomer 0.9.0's components, amber throughout. Recova
// stays the spec for every section, label, column and control and their
// order; the page keeps the settings layout's 800px column.
//
// The plants on the key's security (scope from the session, revoke pinned to
// the account, the hash only) stay in settings-api-keys-s29.test.ts; the
// copy's truth about the agent surface stays in mcp-tools-371.test.ts.
//
// Every assertion here was seen failing against the page before the rebuild.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/api-keys");


const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

interface KeyRow {
  id: string;
  label: string | null;
  createdAt: Date | null;
  lastUsedAt: Date | null;
}

const KEYS: KeyRow[] = [
  { id: "k_2", label: "Newer agent", createdAt: new Date(Date.UTC(2026, 9, 14, 12)), lastUsedAt: null },
  {
    id: "k_1",
    label: "My Claude agent",
    createdAt: new Date(Date.UTC(2026, 8, 3, 12)),
    lastUsedAt: new Date(Date.UTC(2026, 9, 1, 12)),
  },
];

function render(
  opts: {
    keys?: KeyRow[] | null;
    loadError?: boolean;
    isAdmin?: boolean;
    actionData?: Record<string, unknown>;
    url?: string;
  } = {},
): string {
  const loaderData = {
    keys: opts.keys === undefined ? KEYS : opts.keys,
    loadError: opts.loadError ?? false,
    isAdmin: opts.isAdmin ?? false,
    callLog: { state: "owner-only" },
  };
  const Stub = createRoutesStub([
    {
      path: "/settings/api-keys",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [opts.url ?? "/settings/api-keys"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("J34 api keys: the generate form", () => {
  const form = render({ url: "/settings/api-keys?new=1" });

  it("shows no scope picker to a merchant", () => {
    expect(form).not.toContain("cap-seg");
    expect(text(form)).not.toContain("Scope");
  });
});

describe("J34 api keys: the one-time reveal", () => {
  const SECRET = "fox_mcp_sample_secret_0123456789";
  const html = render({ actionData: { action: "create", ok: true, rawKey: SECRET } });

  it("puts the key nowhere but the panel: not in a link, a title, or a data attribute", () => {
    const occurrences = html.split(SECRET).length - 1;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The loader: Recova's order, and its failure state.
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
          email: "owner@example.com",
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

describe("J34 api keys: the loader", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Recova's load-failure state instead of throwing when the read fails", async () => {
    harness.db = new Proxy(
      {},
      {
        get() {
          throw new Error("D1 unavailable");
        },
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = (await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never)) as {
      keys: unknown;
      loadError: boolean;
    };
    expect(loaded.keys).toBeNull();
    expect(loaded.loadError).toBe(true);
  });
});
