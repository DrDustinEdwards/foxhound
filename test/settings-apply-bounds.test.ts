import { describe, expect, it } from "vitest";

import { applyAlertCreate, applyNotificationSettings } from "~/lib/settings/apply.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// lib3 F4: the settings appliers (the forms and the MCP tools both) refuse a
// notification address that is not one address, and free text past its bound,
// before anything reaches a mail header or an AI prompt. Fake data.
const env = { ENCRYPTION_KEY: "ab".repeat(32) } as unknown as Env;

describe("settings bounds", () => {
  it("refuses a notification email carrying a second header", async () => {
    const { db } = createInMemoryDb();
    const result = await applyNotificationSettings(env, db, "acct_1", {
      notificationEmail: "owner@example.com\r\nBcc: someone@example.com",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an alert label of a megabyte", async () => {
    const { db } = createInMemoryDb();
    const result = await applyAlertCreate(
      db,
      "acct_1",
      {
        metric: "active_sequences",
        direction: "above",
        threshold: "10",
        label: "x".repeat(1_000_000),
      },
      new Date("2026-11-23T00:00:00Z"),
    );
    expect(result.ok).toBe(false);
  });
});
