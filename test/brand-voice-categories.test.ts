import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
      expect(prompt).toContain("warm, plain, and direct");
    }
  });

  it("an EMPTY STRING behaves exactly like NULL and falls through", () => {
    // Legacy uses `||` on every rung, so "" and null are the same. That is what
    // lets "Same as main voice" be stored as NULL with no sentinel.
    expect(resolveBrandVoice({ merchantName: "A", voiceDescription: "g", voiceSoft: "" }, "soft")).toBe("g");
    expect(
      resolveBrandVoice({ merchantName: "A", voiceDescription: "g", voiceSoft: "   " }, "soft"),
    ).toBe("g");
    expect(resolveBrandVoice({ merchantName: "A", voiceDescription: "", voiceSoft: "" }, "soft")).toMatch(
      /warm, plain, and direct/,
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
