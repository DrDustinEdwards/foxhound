import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { MCP_TOKEN_PREFIX, verifyMcpToken } from "~/lib/auth/mcp-tokens";

// The prefix check runs before any DB access.

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
