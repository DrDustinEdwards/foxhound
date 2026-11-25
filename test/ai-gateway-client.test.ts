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

// Every model call leaves an ai_calls row, written before the call returns.
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
      costCents: 1,
    });
  });
});
