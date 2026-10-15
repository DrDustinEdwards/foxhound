import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J34 (job_cc3655778b55), row S29, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/api-keys is Recova's page
// (app/(app)/settings/api-keys/page.tsx at blob b50fb228 and ApiKeysClient.tsx
// at blob 338db3db, with its API at app/api/settings/api-keys/route.ts, blob
// 81e694f5) built from Capsomer 0.9.0's components, teal throughout. Recova
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
const { MCP_TOKEN_SCOPE } = await import("~/lib/auth/mcp-tokens");

const SOURCE = readFileSync(new URL("../app/routes/app/settings/api-keys.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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

describe("J34 api keys: the page head", () => {
  it("is Capsomer's PageHead titled as Recova titles it", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">API Keys<\/h1>/);
    expect(html).toContain('<p class="cap-page-head-lead">');
  });

  it("opens with Recova's phone-only back link to the settings hub", () => {
    const html = render();
    const link = html.match(/<a[^>]*href="\/settings"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain("md:hidden");
    expect(text(link)).toBe("Settings");
    // The link comes before the page's heading, as SettingsBackLink does.
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("cap-page-head-title"));
  });

  it("sits in the settings layout's 800px column with no width or padding of its own", () => {
    const html = render();
    expect(html).not.toContain("max-w-3xl");
    expect(html).not.toMatch(/class="mx-auto/);
  });
});

describe("J34 api keys: the keys card", () => {
  it("is a Capsomer panel holding the count line and the Generate new key button", () => {
    const html = render();
    expect(html).toMatch(/<section class="cap-panel">/);
    expect(text(html)).toContain("2 active keys");
    expect(text(render({ keys: [KEYS[0]] }))).toContain("1 active key");
    const generate = html.match(/<a[^>]*>Generate new key<\/a>/)?.[0] ?? "";
    expect(generate).toContain('class="cap-btn"');
    expect(generate).toContain('data-variant="primary"');
    expect(generate).toContain('href="/settings/api-keys?new=1"');
  });

  it("keeps Generate new key in place but disabled while the form is open, as Recova does", () => {
    const html = render({ url: "/settings/api-keys?new=1" });
    const generate = html.match(/<button[^>]*>Generate new key<\/button>/)?.[0] ?? "";
    expect(generate).toContain('class="cap-btn"');
    expect(generate).toContain('aria-disabled="true"');
    expect(generate).toMatch(/aria-describedby="[^"]+"/);
  });

  it("lists the keys in a Capsomer table with Recova's four columns in order", () => {
    const html = render();
    expect(html).toMatch(/<div class="cap-table-wrap"[^>]*role="region"[^>]*aria-label="API keys"[^>]*tabindex="0"/);
    expect(html).toContain('<table class="cap-table">');
    const heads = [...html.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
    expect(heads).toEqual(["Label", "Created", "Last used", "Actions"]);
  });

  it("formats dates as Recova does and says Never for a key never used", () => {
    const html = render();
    expect(text(html)).toContain("Oct 14, 2026");
    expect(text(html)).toContain("Never");
    expect(text(html)).toContain("Oct 1, 2026");
  });

  it("gives each Revoke key button a Capsomer look and a name that says which key", () => {
    const html = render();
    const buttons = [...html.matchAll(/<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/g)];
    const revokes = buttons.filter((m) => m[1].includes("Revoke key"));
    expect(revokes).toHaveLength(2);
    for (const m of revokes) expect(m[0]).toContain('class="cap-btn"');
    expect(text(revokes[0][1])).toBe("Revoke key Newer agent");
    expect(revokes[0][1]).toContain('<span class="sr-only">');
  });

  it("shows Recova's empty sentence through Capsomer's empty state", () => {
    const html = render({ keys: [] });
    expect(html).toMatch(/<div class="cap-empty" data-kind="nothing-yet"/);
    expect(text(html)).toContain("No API keys yet. Generate one to get started.");
    expect(text(html)).toContain("0 active keys");
    expect(html).not.toContain("cap-table");
  });

  it("drops the empty sentence while the form is open, as Recova does", () => {
    expect(text(render({ keys: [], url: "/settings/api-keys?new=1" }))).not.toContain("No API keys yet.");
  });

  it("says Recova's load failure in a Capsomer alert and claims no count", () => {
    const html = render({ keys: null, loadError: true });
    expect(html).toContain("cap-alert");
    expect(text(html)).toContain("Couldn't load your API keys. Refresh the page or try again later.");
    expect(text(html)).not.toMatch(/active key/);
    expect(text(html)).not.toContain("Loading...");
  });

  it("announces a revoke without a visible banner, since Recova only drops the row", () => {
    const html = render({ actionData: { action: "revoke", ok: true } });
    expect(html).toMatch(/<p role="status" class="sr-only">Key revoked\.<\/p>/);
  });
});

describe("J34 api keys: the generate form", () => {
  const form = render({ url: "/settings/api-keys?new=1" });

  it("carries Recova's heading line, a labelled Capsomer input and Recova's example", () => {
    expect(text(form)).toContain("Generate a new API key");
    const input = form.match(/<input[^>]*name="label"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('class="cap-input"');
    expect(input).toContain('placeholder="e.g. My Claude agent"');
    expect(input).toContain("required");
    expect(form).toMatch(/<div class="cap-field">[\s\S]*<label class="cap-field-label"/);
  });

  it("has Generate key as the primary submit and Cancel beside it", () => {
    const submit = form.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?Generate key[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(submit).toContain('class="cap-btn"');
    expect(submit).toContain('data-variant="primary"');
    const cancel = form.match(/<a[^>]*>Cancel<\/a>/)?.[0] ?? "";
    expect(cancel).toContain('class="cap-btn"');
  });

  it("shows no scope picker to a merchant", () => {
    expect(form).not.toContain("cap-seg");
    expect(text(form)).not.toContain("Scope");
  });

  it("shows an admin Recova's Scope choice as a Capsomer segmented control, Merchant first and chosen", () => {
    const html = render({ isAdmin: true, url: "/settings/api-keys?new=1" });
    expect(html).toMatch(/<fieldset class="cap-seg"[^>]*><legend>Scope<\/legend>/);
    const radios = [...html.matchAll(/<input type="radio" name="scope"[^>]*>/g)].map((m) => m[0]);
    expect(radios.map((r) => r.match(/value="(\w+)"/)?.[1])).toEqual(["merchant", "admin"]);
    expect(radios[0]).toContain("checked");
    expect(radios[1]).not.toContain("checked");
    expect(text(html)).toMatch(/Merchant\s*Admin/);
  });

  it("warns about admin keys only once Admin is chosen, in Recova's words", () => {
    const html = render({ isAdmin: true, url: "/settings/api-keys?new=1" });
    expect(html).not.toContain("Admin keys are platform-wide");
    expect(CODE).toContain("Admin keys are platform-wide and can access any merchant account. Use with care.");
    expect(CODE).toMatch(/scope === "admin" \?/);
  });
});

describe("J34 api keys: the one-time reveal", () => {
  const SECRET = "fox_mcp_sample_secret_0123456789";
  const html = render({ actionData: { action: "create", ok: true, rawKey: SECRET } });

  it("shows the key once with Recova's warning, Copy key and Done", () => {
    expect(text(html)).toContain("Your new API key");
    expect(html).toMatch(new RegExp(`<pre[^>]*>${SECRET}</pre>`));
    expect(text(html)).toContain("This key will not be shown again. Copy it now and store it somewhere safe.");
    const copy = html.match(/<button[^>]*>Copy key<\/button>/)?.[0] ?? "";
    expect(copy).toContain('class="cap-btn"');
    const done = html.match(/<a[^>]*>Done<\/a>/)?.[0] ?? "";
    expect(done).toContain('class="cap-btn"');
  });

  it("keeps Generate new key in place but disabled while the key shows", () => {
    const generate = html.match(/<button[^>]*>Generate new key<\/button>/)?.[0] ?? "";
    expect(generate).toContain('aria-disabled="true"');
  });

  it("copies through the clipboard, says Copied, and falls back in Recova's words without a browser alert", () => {
    expect(CODE).toContain("navigator.clipboard.writeText(");
    expect(CODE).toContain('"Copied"');
    expect(CODE).toContain("Couldn't copy the key to your clipboard. Select and copy it manually.");
    expect(CODE).not.toMatch(/\balert\(/);
  });

  it("puts the key nowhere but the panel: not in a link, a title, or a data attribute", () => {
    const occurrences = html.split(SECRET).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("J34 api keys: the look comes from Capsomer and the tokens", () => {
  it("has no amber and no hand-sized text", () => {
    expect(CODE).not.toMatch(/amber/i);
    expect(CODE).not.toMatch(/text-\[/);
  });

  it("styles no Capsomer component with Foxhound classes of its own", () => {
    // Q10: until Capsomer's per-site layer exists, a Capsomer part is used as
    // it ships. A Tailwind class string on a cap-* element would be that layer
    // written by hand.
    for (const m of CODE.matchAll(/className="(cap-[^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) expect(cls).toMatch(/^cap-/);
    }
  });

  it("loads each Capsomer stylesheet it uses", () => {
    for (const css of ["page-head", "panel", "table", "button", "field", "segmented", "empty", "banner"]) {
      expect(SOURCE).toContain(`import "capsomer/${css}.css";`);
    }
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

  it("lists the newest key first, as Recova's API orders it (created_at descending)", async () => {
    const insert = sqlite.prepare(
      "INSERT INTO api_keys (id, account_id, key_hash, label, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("k_old", ACCOUNT, "h1", "Oldest", MCP_TOKEN_SCOPE.MERCHANT, 1000);
    insert.run("k_new", ACCOUNT, "h3", "Newest", MCP_TOKEN_SCOPE.MERCHANT, 3000);
    insert.run("k_mid", ACCOUNT, "h2", "Middle", MCP_TOKEN_SCOPE.MERCHANT, 2000);

    const loaded = (await route.loader({ context: ctx(), request: new Request("https://x/"), params: {} } as never)) as {
      keys: { label: string }[];
    };
    expect(loaded.keys.map((k) => k.label)).toEqual(["Newest", "Middle", "Oldest"]);
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

  it("never logs the secret it returns", async () => {
    const calls: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }
    const form = new FormData();
    form.append("_action", "create");
    form.append("label", "My Claude agent");
    const res = (await route.action({
      context: ctx(),
      request: new Request("https://x/settings/api-keys", { method: "POST", body: form }),
      params: {},
    } as never)) as unknown as { data: { rawKey?: string } };
    const raw = String(res.data.rawKey);
    expect(raw.length).toBeGreaterThan(20);
    expect(JSON.stringify(calls)).not.toContain(raw);
  });
});
