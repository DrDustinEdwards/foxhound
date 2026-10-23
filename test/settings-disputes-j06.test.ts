import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J06 (job_4f4c9c2f5383), row S32: /settings/disputes. Recova's spec is
// settings/disputes/page.tsx (9d927c62), DisputesForm.tsx (6a769d95) and
// settings/components/DisputesSection.tsx (eb7bba4d). Only the settings with a
// reader are built (RULES.md 3.18): the product description (dispute intake's
// evidence) and ships physical goods (the dispute page's shipping inputs).
// Auto-submit is never built (RULES.md 5.6).

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/disputes");
const { applyDisputeSettings, DISPUTE_PRODUCT_DESCRIPTION_ERROR } = await import("~/lib/settings/apply.server");
const { readDisputeSettings, readDisputeProductDescription } = await import("~/lib/disputes/queries.server");
const { splitEvidence } = await import("~/lib/disputes/detail");

const SOURCE = readFileSync(new URL("../app/routes/app/settings/disputes.tsx", import.meta.url), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('a1', 'Acme', 1000)").run();
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('a2', 'Other', 1000)").run();
});

function columns(id: string) {
  return sqlite
    .prepare(
      "SELECT dispute_product_description AS d, dispute_ships_physical AS s, dispute_auto_submit AS a FROM accounts WHERE id = ?",
    )
    .get(id) as { d: string | null; s: number | null; a: number | null };
}

const Page = route.default as unknown as (props: {
  loaderData: Record<string, unknown>;
  actionData?: Record<string, unknown>;
}) => ReactElement;

function render(loaderData: { productDescription: string; shipsPhysical: boolean }, actionData?: Record<string, unknown>) {
  const Stub = createRoutesStub([
    { path: "/settings/disputes", Component: () => createElement(Page, { loaderData, actionData }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/disputes"] }));
}

describe("S32 THE WRITER: two columns, pinned to the account", () => {
  it("writes the description and the toggle, and never auto-submit", async () => {
    const result = await applyDisputeSettings(db, "a1", {
      productDescription: "  Handmade candles  ",
      shipsPhysical: true,
    });
    expect(result.ok).toBe(true);
    expect(columns("a1")).toEqual({ d: "Handmade candles", s: 1, a: null });
    expect(columns("a2")).toEqual({ d: null, s: null, a: null });
  });

  it("a blank description is stored as not set", async () => {
    await applyDisputeSettings(db, "a1", { productDescription: "Candles", shipsPhysical: false });
    await applyDisputeSettings(db, "a1", { productDescription: "   ", shipsPhysical: false });
    expect(columns("a1")).toEqual({ d: null, s: 0, a: null });
  });

  it("a description past Stripe's evidence limit is refused and nothing is written", async () => {
    const result = await applyDisputeSettings(db, "a1", { productDescription: "x".repeat(20_001), shipsPhysical: true });
    expect(result).toEqual({ ok: false, error: DISPUTE_PRODUCT_DESCRIPTION_ERROR });
    expect(columns("a1")).toEqual({ d: null, s: null, a: null });
  });
});

describe("S32 THE READERS: NULL is off and empty, as Recova's ?? false and ?? ''", () => {
  it("an account that never saved reads as blank and off", async () => {
    expect(await readDisputeSettings(db, "a1")).toEqual({ productDescription: "", shipsPhysical: false });
    expect(await readDisputeProductDescription(db, "a1")).toBeNull();
  });

  it("the saved description is what intake reads", async () => {
    await applyDisputeSettings(db, "a1", { productDescription: "Candles", shipsPhysical: true });
    expect(await readDisputeProductDescription(db, "a1")).toBe("Candles");
    expect((await readDisputeSettings(db, "a1")).shipsPhysical).toBe(true);
  });

  it("the dispute page keeps shipping evidence out of the read-only list while its inputs show", () => {
    const rows = [
      { id: "1", fieldName: "shipping_tracking_number", fieldValue: "1Z999" },
      { id: "2", fieldName: "shipping_carrier", fieldValue: "UPS" },
      { id: "3", fieldName: "product_description", fieldValue: "Candles" },
    ];
    const editing = splitEvidence(rows, true, true);
    expect(editing.structured.map((r) => r.fieldName)).toEqual(["product_description"]);
    expect(editing.shipping).toEqual({ shipping_tracking_number: "1Z999", shipping_carrier: "UPS", shipping_date: "" });
    // Once locked (submitted, or the account does not ship), they are rows.
    expect(splitEvidence(rows, false, false).structured).toHaveLength(3);
  });
});

describe("S32 THE PAGE: Recova's content, in Recova's order, from Capsomer", () => {

  it("there is no auto-submit control anywhere on it (RULES.md 5.6)", () => {
    const html = render({ productDescription: "", shipsPhysical: false });
    expect(html.toLowerCase()).not.toContain("auto-submit");
    expect(CODE).not.toContain("dispute_auto_submit");
    expect(CODE).not.toContain("disputeAutoSubmit");
  });
});
