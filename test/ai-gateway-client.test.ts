import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { aiCalls } from "~/db";

import { createInMemoryDb } from "./helpers/inmemory-db";

const { db } = createInMemoryDb();
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => db,
}));

const { askModel } = await import("~/lib/ai/client");

// Where the calls go, the retry layer and the stop reasons are site-runtime's
// ./anthropic and are tested there, once. What this plant defends is Foxhound's
// meter: every model call costs money, so every one leaves an ai_calls row, and
// the row is written before the call returns, so a Worker that answers at once
// cannot drop it.
describe("every call is metered", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes one ai_calls row per call with the call's tokens, source and cost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 2_000, output_tokens: 500 },
        }),
      ),
    );
    const result = await askModel(
      { ANTHROPIC_API_KEY: "sk-test" } as unknown as Env,
      { source: "recovery_email", accountId: null, relatedId: "fp_1" },
      { model: "claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] },
      { log: false },
    );
    expect(result.ok).toBe(true);

    const rows = await db.select().from(aiCalls).where(eq(aiCalls.relatedId, "fp_1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "recovery_email",
      model: "claude-sonnet-5",
      promptTokens: 2_000,
      completionTokens: 500,
      // 2,000 x $3/M + 500 x $15/M = 1.35 cents, rounded up.
      costCents: 2,
    });
  });
});
