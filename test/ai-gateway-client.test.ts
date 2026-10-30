import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { aiCalls } from "~/db";

import { createInMemoryDb } from "./helpers/inmemory-db";

const { db } = createInMemoryDb();
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => db,
}));

const { createAnthropicClient } = await import("~/lib/ai/client");

// SESSION 54 / 346: AI Gateway in front of the Anthropic calls.
//
// Where the calls go (gateway or direct, the token, body logging off) is
// site-runtime's anthropicRoute and is tested there, once. What these plants
// defend is that the decision stays in one place here too: four call sites
// each built their own client, and four copies of a routing decision is four
// chances to get it wrong.

describe("the factory", () => {
  it("refuses to build a client with no key, as every call site did before", () => {
    expect(() => createAnthropicClient({} as unknown as Env, { source: "test", accountId: null })).toThrow(
      "ANTHROPIC_API_KEY",
    );
  });
});

// Every model call costs money, so every one leaves an ai_calls row: the
// factory meters the client it hands out, so a call site cannot forget to.
describe("the factory meters every call", () => {
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
    const client = createAnthropicClient({ ANTHROPIC_API_KEY: "sk-test" } as unknown as Env, {
      source: "recovery_email",
      accountId: null,
      relatedId: "fp_1",
    });
    await client.messages.create({ model: "claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] });

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

