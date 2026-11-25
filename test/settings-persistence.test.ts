import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildBrandVoiceUpdate } from "~/lib/settings/persist.server";

const db = drizzle({} as never, { schema });

describe("buildBrandVoiceUpdate", () => {
  it("pins the account in the WHERE as well as the client-supplied connection id", () => {
    const { sql, params } = buildBrandVoiceUpdate(db, "acc_1", "conn_1", "Warm and direct").toSQL();
    expect(sql).toMatch(/update .*stripe_connections/i);
    expect(sql).toMatch(/account_id/);
    expect(params).toContain("conn_1");
    expect(params).toContain("acc_1");
  });
});
