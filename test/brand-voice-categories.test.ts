import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S31, the four per-category brand voices. Ruled parity by 337 binding 6:
// legacy's resolveBrandVoice takes the decline category and Foxhound's did not,
// which is a Foxhound-internal narrowing of a legacy feature, removed under 324.
//
// THE PLANTS OBSERVE THE SYSTEM PROMPT, because that is where Foxhound puts the
// resolved voice. Legacy puts it in the user message; a plant reading only the
// user prompt would miss this feature entirely.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { queryDueRecoverySteps, toEmailContext } = await import("~/lib/cron/recovery-tick");
const { buildPrompts, resolveBrandVoice } = await import("~/lib/recovery/email-generation");
const { buildGenerateEmailInput } = await import("~/lib/engine/execute-step");
const { DECLINE_CATEGORIES } = await import("~/lib/constants");
const { BRAND_VOICE_PRESETS, CATEGORY_VOICE_ROWS } = await import("~/lib/settings/brand-voice-presets");
const { action: brandVoiceAction } = await import("~/routes/app/settings/brand-voice");

const ACCOUNT = "acct_1";
const NOW = new Date(10_000_000);

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
});

interface Voices {
  general?: string | null;
  soft?: string | null;
  expired?: string | null;
  network?: string | null;
  fraud?: string | null;
}

/** One account, one connection carrying the voices, one due step in `category`. */
function seed(category: string, v: Voices): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)")
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, sender_name, brand_voice, brand_voice_soft, brand_voice_expired, brand_voice_network, brand_voice_fraud, connected_at, created_at) VALUES ('c1', ?, 'acct_s', 1, 'Alex', ?, ?, ?, ?, ?, 1000, 1000)",
    )
    .run(
      ACCOUNT,
      v.general ?? null,
      v.soft ?? null,
      v.expired ?? null,
      v.network ?? null,
      v.fraud ?? null,
    );
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at, stripe_connection_id) VALUES ('fp1', ?, 'evt', 'in_1', 'cus_1', 'c@acme.test', 9900, 'usd', ?, 'active', 1000, 'c1')",
    )
    .run(ACCOUNT, category);
  sqlite
    .prepare(
      "INSERT INTO recovery_steps (id, account_id, failed_payment_id, step_type, step_number, scheduled_at, attempt_count) VALUES ('s1', ?, 'fp1', 'email', 1, 1000, 0)",
    )
    .run(ACCOUNT);
}

/** The whole path, ending at the SYSTEM string the model receives. */
async function systemPromptFor(category: string, v: Voices): Promise<string> {
  seed(category, v);
  const rows = await queryDueRecoverySteps({} as Env, NOW);
  expect(rows).toHaveLength(1);
  const ctx = toEmailContext(rows[0]);
  return buildPrompts(buildGenerateEmailInput("https://foxhoundapp.test/u/1", ctx)).system;
}

describe("PLANT 1: the category's own voice reaches the prompt for that category", () => {
  it("a soft decline uses the soft voice, not the general one", async () => {
    const prompt = await systemPromptFor("soft", {
      general: "general house voice",
      soft: "gentle and unhurried",
    });
    expect(prompt).toContain("gentle and unhurried");
    expect(prompt).not.toContain("general house voice");
  });

  it("THE SAME MERCHANT gets the GENERAL voice for a category they left blank", async () => {
    // The sharp case: one merchant, one connection, two categories, two
    // different voices out. A resolver that ignored the category would return
    // the same string for both.
    const expiredPrompt = await systemPromptFor("expired", {
      general: "general house voice",
      soft: "gentle and unhurried",
    });
    expect(expiredPrompt).toContain("general house voice");
    expect(expiredPrompt).not.toContain("gentle and unhurried");
  });

  it("each of the four columns is wired to its own category", async () => {
    const cases: [string, Voices, string][] = [
      ["soft", { soft: "voice for soft" }, "voice for soft"],
      ["expired", { expired: "voice for expired" }, "voice for expired"],
      ["network", { network: "voice for network" }, "voice for network"],
      ["fraud", { fraud: "voice for fraud" }, "voice for fraud"],
    ];
    for (const [category, voices, expected] of cases) {
      ({ sqlite, db } = createInMemoryDb());
      harness.db = db;
      const prompt = await systemPromptFor(category, { general: "general house voice", ...voices });
      expect(prompt).toContain(expected);
      expect(prompt).not.toContain("general house voice");
    }
  });
});

describe("PLANT 2: legacy's resolution order, all three rungs", () => {
  it("only a general voice set: every category gets it", async () => {
    for (const category of DECLINE_CATEGORIES) {
      ({ sqlite, db } = createInMemoryDb());
      harness.db = db;
      const prompt = await systemPromptFor(category, { general: "one voice for everything" });
      expect(prompt).toContain("one voice for everything");
    }
  });

  it("nothing set at all: the constant default, for every category", async () => {
    for (const category of DECLINE_CATEGORIES) {
      ({ sqlite, db } = createInMemoryDb());
      harness.db = db;
      const prompt = await systemPromptFor(category, {});
      // Legacy's BRAND_VOICE_DEFAULT byte for byte (338).
      expect(prompt).toContain("Friendly and direct. Write like a real person, not a company.");
    }
  });

  it("an EMPTY STRING behaves exactly like NULL and falls through", () => {
    // Legacy uses `||` on every rung, so "" and null are the same. That is what
    // lets "Same as main voice" be stored as NULL with no sentinel.
    expect(resolveBrandVoice({ merchantName: "A", voiceDescription: "g", voiceSoft: "" }, "soft")).toBe("g");
    expect(
      resolveBrandVoice({ merchantName: "A", voiceDescription: "g", voiceSoft: "   " }, "soft"),
    ).toBe("g");
    expect(resolveBrandVoice({ merchantName: "A", voiceDescription: "", voiceSoft: "" }, "soft")).toBe(
      "Friendly and direct. Write like a real person, not a company.",
    );
  });
});

describe("PLANT 3: six categories against four columns", () => {
  it("revoked and unknown resolve to the general voice, via legacy's default arm", async () => {
    for (const category of ["revoked", "unknown"]) {
      ({ sqlite, db } = createInMemoryDb());
      harness.db = db;
      const prompt = await systemPromptFor(category, {
        general: "general house voice",
        soft: "voice for soft",
        expired: "voice for expired",
        network: "voice for network",
        fraud: "voice for fraud",
      });
      expect(prompt).toContain("general house voice");
      // Crucially it does not leak SOME OTHER category's voice into them.
      for (const other of ["voice for soft", "voice for expired", "voice for network", "voice for fraud"]) {
        expect(prompt).not.toContain(other);
      }
    }
  });

  it("every DECLINE_CATEGORIES key resolves to something non-empty", () => {
    for (const category of DECLINE_CATEGORIES) {
      expect(resolveBrandVoice({ merchantName: "A" }, category).length).toBeGreaterThan(0);
    }
  });
});

describe("PLANT 4: 309's bound holds", () => {
  it("findBrandVoiceViolations reads COPY and has no dispute caller", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const gen = readFileSync(
      fileURLToPath(new URL("../app/lib/recovery/email-generation.ts", import.meta.url)),
      "utf8",
    );
    // The gate takes EmailCopy. It has never read the resolved voice, on either
    // side: the name describes what it protects, not what it reads.
    expect(gen).toContain("export function findBrandVoiceViolations(copy: EmailCopy)");

    const disputes = readFileSync(
      fileURLToPath(new URL("../app/lib/disputes/queries.server.ts", import.meta.url)),
      "utf8",
    );
    expect(disputes).not.toContain("findBrandVoiceViolations");
    expect(disputes).not.toContain("passesQualityGate");
  });
});

describe("PLANT 5: the settings surface renders exactly the four legacy fields", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/brand-voice.tsx", import.meta.url)),
    "utf8",
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the four categories legacy has a column for, and NOT the two it does not", () => {
    for (const key of ["soft", "expired", "network", "fraud"]) {
      expect(CATEGORY_VOICE_ROWS.some((r) => r.key === key)).toBe(true);
    }
    // revoked and unknown resolve to the general voice through legacy's default
    // arm. A field for them would be inventing a column.
    expect(CATEGORY_VOICE_ROWS).toHaveLength(4);
    expect(code).not.toContain("voice_revoked");
    expect(code).not.toContain("voice_unknown");
  });

  it("carries legacy's option set and its custom reveal", () => {
    expect(code).toContain("Same as main voice");
    expect(code).toContain("Custom...");
    expect(BRAND_VOICE_PRESETS).toHaveLength(7);
  });

  it("no bound on any field, which is legacy", () => {
    expect(code).not.toContain("maxLength");
    expect(code).not.toContain("required");
  });

  it("the write goes through DemoGuardedForm", () => {
    expect(code).toContain('<DemoGuardedForm method="post"');
    expect(code).not.toContain('<Form method="post"');
    expect(code).not.toContain('<form method="post"');
  });

  it("the docs describe the built shape, not one field", () => {
    const docs = readFileSync(
      fileURLToPath(new URL("../app/lib/marketing/docs-content.ts", import.meta.url)),
      "utf8",
    );
    expect(docs).not.toContain("one brand voice field");
    expect(docs).toContain("a different tone for each failure category");
    expect(docs).toContain("falls back to the main one");
    // J36: Recova's page has no main-voice field, so neither does this one,
    // and the docs must not send a merchant to look for it there.
    expect(docs).not.toContain("holds the main brand voice");
    expect(docs).not.toContain("The page holds the main voice");
  });
});

describe("PLANT 6: the save writes exactly the four columns", () => {
  const ctx = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
          memberships: [
            { memberId: "m1", accountId: "acct_other", accountName: "Other", role: "owner" },
            { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
          ],
          activeAccountId: ACCOUNT,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as unknown as Parameters<typeof brandVoiceAction>[0]["context"];

  async function post(fields: Record<string, string>): Promise<number> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = (await brandVoiceAction({
      context: ctx,
      request: new Request("https://foxhoundapp.test/settings/brand-voice", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never)) as unknown as { init?: { status?: number } };
    return res.init?.status ?? 200;
  }

  function connectionRow() {
    return sqlite
      .prepare(
        "SELECT brand_voice AS general, brand_voice_soft AS soft, brand_voice_expired AS expired, brand_voice_network AS network, brand_voice_fraud AS fraud FROM stripe_connections WHERE id = 'c1'",
      )
      .get() as Record<string, string | null>;
  }

  it("saves the four and leaves the general voice as it is", async () => {
    // CHANGED BY J36, with legacy as the authority, read whole at its blob:
    // BrandVoiceSection.tsx (blob 9f4de70c) posts ONLY the four category hidden
    // inputs (lines 63 to 66) and BrandVoiceForm.tsx (blob 8dd126bf) adds only
    // connection_id. Nothing on Recova's page posts brand_voice_preset, so its
    // update route's `has(...)` guard (settings/update/route.ts:115) leaves
    // brand_voice untouched on this save. Session 59 read the preset constant's
    // name in BrandVoiceSection as a general picker; there is none.
    seed("soft", { general: "house voice" });

    const status = await post({
      connectionId: "c1",
      voice_soft: "gentle",
      voice_expired: "practical",
      voice_network: "reassuring",
      voice_fraud: "calm",
    });

    expect(status).toBe(200);
    const row = connectionRow();
    expect(row.soft).toBe("gentle");
    expect(row.expired).toBe("practical");
    expect(row.network).toBe("reassuring");
    expect(row.fraud).toBe("calm");
    expect(row.general).toBe("house voice");
  });

  it("A POSTED GENERAL VOICE WRITES NOTHING: the page has no such field", async () => {
    seed("soft", { general: "house voice" });

    await post({
      connectionId: "c1",
      voice_soft: "gentle",
      brandVoice: "hijacked",
      brand_voice: "hijacked",
      brand_voice_preset: "custom",
      brand_voice_custom: "hijacked",
    });

    const row = connectionRow();
    expect(row.soft).toBe("gentle");
    expect(row.general).toBe("house voice");
  });

  it("A POSTED FIFTH VOICE NAME WRITES NOTHING", async () => {
    seed("soft", { general: "house voice" });

    await post({
      connectionId: "c1",
      voice_soft: "gentle",
      voice_revoked: "sneaky",
      voice_unknown: "sneaky",
      senderName: "hijacked",
    });

    const row = connectionRow();
    expect(row.soft).toBe("gentle");
    expect(row.general).toBe("house voice");
    const sender = sqlite
      .prepare("SELECT sender_name AS s FROM stripe_connections WHERE id = 'c1'")
      .get() as { s: string | null };
    expect(sender.s).toBe("Alex");
    // The two categories legacy has no column for stored nowhere at all.
    const cols = sqlite.prepare("PRAGMA table_info(stripe_connections)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "brand_voice_revoked")).toBe(false);
  });

  it("an empty selection stores NULL, which reads back as same-as-main", async () => {
    seed("soft", { general: "house voice", soft: "gentle" });
    await post({ connectionId: "c1", voice_soft: "", voice_expired: "  " });
    const row = connectionRow();
    expect(row.soft).toBeNull();
    expect(row.expired).toBeNull();
  });

  it("400 and NO write with no connection id", async () => {
    seed("soft", { general: "house voice", soft: "gentle" });
    expect(await post({ voice_soft: "changed" })).toBe(400);
    expect(connectionRow().soft).toBe("gentle");
  });

  it("a connection on ANOTHER account is refused by the WHERE", async () => {
    seed("soft", { general: "house voice", soft: "gentle" });
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_other', 'Other', 1000)").run();
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, brand_voice_soft, connected_at, created_at) VALUES ('c_theirs', 'acct_other', 'acct_x', 1, 'theirs', 1000, 1000)",
      )
      .run();

    await post({ connectionId: "c_theirs", voice_soft: "hijacked" });

    const theirs = sqlite
      .prepare("SELECT brand_voice_soft AS s FROM stripe_connections WHERE id = 'c_theirs'")
      .get() as { s: string | null };
    expect(theirs.s).toBe("theirs");
  });
});
