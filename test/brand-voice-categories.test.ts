
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

const { queryDueRecoverySteps, toEmailContext } = await import("~/lib/cron/due-steps");
const { buildPrompts, resolveBrandVoice } = await import("~/lib/recovery/email-generation");
const { buildGenerateEmailInput } = await import("~/lib/engine/execute-step");
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

  it("400 and NO write with no connection id", async () => {
    seed("soft", { general: "house voice", soft: "gentle" });
    expect(await post({ voice_soft: "changed" })).toBe(400);
    expect(connectionRow().soft).toBe("gentle");
  });
});
