import { describe, expect, it } from "vitest";

import { accounts, cronConfig } from "~/db";
import { setCronEnabled } from "~/lib/admin/crons.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

describe("setCronEnabled refuses an unknown name", () => {
  async function db() {
    const { db } = createInMemoryDb();
    await db.insert(accounts).values({ id: "acct_1", name: "A", createdAt: new Date() });
    return db;
  }

  it("writes no row for a mistyped name", async () => {
    const d = await db();
    await expect(setCronEnabled(d, "demo_reset", false)).rejects.toThrow(/unknown cron name/);
    const rows = await d.select().from(cronConfig);
    expect(rows).toEqual([]);
  });
});
