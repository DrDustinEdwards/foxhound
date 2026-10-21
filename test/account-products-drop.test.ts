import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 298: account_products is DROPPED.
//
// The table was vestigial from the rebuild: ZERO writers, and a data-flow trace
// (query to prop to render, per 298's own rule rather than an identifier grep)
// found exactly one query in admin/merchants.server.ts feeding exactly one
// rendered card in admin/merchants/detail.tsx. Because nothing ever wrote it,
// that card rendered "None." for every merchant on every visit.
//
// 292 first named the table vestigial when the win-back Intelligence gate was
// rewired off it onto the live account_subscriptions capability. 297 tried to
// drop it and HALTED correctly: its premise was one reader and there were two,
// the second being the rendered card. 298 ruled the card goes with the table.
//
// The absence assertion runs against the MIGRATED schema: the in-memory harness
// applies every committed migration in order, so 0000 creates the table and
// 0015 drops it. Reading sqlite_master is what makes this a schema fact rather
// than a source-text claim.
//
// The tree is CRLF; the source matchers normalize.

const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const DETAIL = norm("app/routes/admin/merchants/detail.tsx");
const MERCHANTS = norm("app/lib/admin/merchants.server.ts");
const SCHEMA = readdirSync("app/db/schema")
  .map((f) => norm(`app/db/schema/${f}`))
  .join("\n");

function tableNames(): string[] {
  const { sqlite } = createInMemoryDb();
  const rows = sqlite
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("298: the table is gone from the migrated schema", () => {
  it("account_products does not exist after the committed migrations run", () => {
    expect(tableNames()).not.toContain("account_products");
  });

  it("REGRESSION GUARD: account_subscriptions survives, and the read is real", () => {
    // Non-vacuous in two directions. It proves the sqlite_master query returns a
    // populated set rather than nothing (a content assertion that can pass by
    // reading nothing is the failure mode conventions names), and it proves the
    // migration dropped the vestigial table and NOT the live one beside it,
    // which is the mistake this drop could plausibly have made.
    const names = tableNames();
    expect(names).toContain("account_subscriptions");
    expect(names.length).toBeGreaterThan(40);
  });

  it("the migration is a plain DROP, needing no foreign-key recreate", () => {
    // Nothing FKs INTO account_products (measured), so SQLite needs none of the
    // defer_foreign_keys table-rebuild dance that 0014 required.
    const sql = norm("drizzle/migrations/0015_steady_azazel.sql").trim();
    expect(sql).toBe("DROP TABLE `account_products`;");
  });
});

describe("298: the data flow is gone at every hop", () => {
  it("the table definition leaves the schema", () => {
    expect(SCHEMA).not.toContain("accountProducts");
    expect(SCHEMA).not.toContain("account_products");
  });

  it("the query and the prop leave getMerchantDetail", () => {
    expect(MERCHANTS).not.toContain("accountProducts");
    expect(MERCHANTS).not.toContain("products,");
    expect(MERCHANTS).toContain("subscriptions,");
  });

  it("the prop leaves the component destructure", () => {
    expect(DETAIL).not.toContain(", products,");
  });
});

describe("298: the admin surface after the card is removed", () => {
  it("the Products card is gone", () => {
    expect(DETAIL).not.toContain(">Products</p>");
    expect(DETAIL).not.toContain("products.map");
  });

  it("REGRESSION GUARD: Subscriptions still renders, with its admin-granted marker", () => {
    // The card that shares the removed one's subject. If the removal had taken
    // the wrong sibling, or the grid unwrap had dropped a child, this fails.
    expect(DETAIL).toContain(">Subscriptions</p>");
    expect(DETAIL).toContain("subscriptions.map");
    expect(DETAIL).toContain("(admin-granted)");
  });

  it("Subscriptions is now a full-width section, not a one-child grid", () => {
    // The stated resolution: it matches this page's four other full-width
    // sections rather than sitting alone in a grid built for two.
    const idx = DETAIL.indexOf(">Subscriptions</p>");
    expect(idx).toBeGreaterThan(-1);
    const opener = DETAIL.lastIndexOf("<section", idx);
    const section = DETAIL.slice(opener, idx);
    expect(section).toContain('<section className="mt-6 rounded-lg border border-border bg-surface p-4">');
    expect(section).not.toContain("sm:grid-cols-2");
  });

  it("REGRESSION GUARD: the page's OTHER two-column grid is untouched", () => {
    // Exactly one two-column grid should remain. Two would mean the unwrap
    // missed; zero would mean it took a section it was not asked to touch.
    expect(DETAIL.match(/sm:grid-cols-2/g)?.length).toBe(1);
  });
});
