import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import {
  hashMcpToken,
  MCP_TOKEN_PREFIX,
  verifyMcpToken,
} from "~/lib/auth/mcp-tokens";

// Pure-logic coverage for the MCP token model. Issuance/verification against a
// real api_keys table is exercised in Phase 7 (the MCP consumes this model).

describe("hashMcpToken", () => {
  it("is deterministic and hex SHA-256 (64 chars)", async () => {
    const a = await hashMcpToken("fox_mcp_abc");
    const b = await hashMcpToken("fox_mcp_abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyMcpToken", () => {
  it("rejects tokens without the MCP prefix before any DB access", async () => {
    // Db is never touched on the prefix short-circuit; a throwing stub proves it.
    const throwingDb = {
      select() {
        throw new Error("DB should not be queried for a non-MCP token");
      },
    } as unknown as Db;
    expect(await verifyMcpToken(throwingDb, "not-a-token")).toBeNull();
    expect(await verifyMcpToken(throwingDb, `${MCP_TOKEN_PREFIX}`.slice(0, 3))).toBeNull();
  });
});
