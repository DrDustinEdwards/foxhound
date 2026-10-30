import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J06, row S32: /settings/disputes. Recova's spec is
// settings/disputes/page.tsx (9d927c62), DisputesForm.tsx (6a769d95) and
// settings/components/DisputesSection.tsx (eb7bba4d). Each setting has a
// reader: auto-submit (the disputes cron), the product
// description (dispute intake's evidence) and ships physical goods (the dispute
// page's shipping inputs).

const harness = vi.hoisted(() => ({ db: null as unknown, moneyWrites: [] as unknown[] }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Dispute intake's money write, recorded rather than sent to the Durable Object.
vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: unknown, write: { build: (db: unknown) => unknown[] }) => {
    harness.moneyWrites.push(write.build(harness.db));
    return { applied: true };
  },
}));

const route = await import("~/routes/app/settings/disputes");
const { applyDisputeSettings, applyDisputesEnabled, DISPUTE_PRODUCT_DESCRIPTION_ERROR } = await import(
  "~/lib/settings/apply.server"
);
const { readDisputeSettings, readDisputeProductDescription } = await import("~/lib/disputes/queries.server");
const { handleStampDispute } = await import("~/lib/webhooks/dispute-handlers");
const { importDisputeFromStripe } = await import("~/lib/disputes/manual-import.server");
const { splitEvidence } = await import("~/lib/disputes/detail");


let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.moneyWrites = [];
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('a1', 'Acme', 1000)").run();
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('a2', 'Other', 1000)").run();
});

const ACTOR = { userId: "u1", email: "owner@a1.test", now: new Date(5000) };

function optIn(id: string) {
  return sqlite
    .prepare(
      "SELECT dispute_auto_submit_by_user_id AS u, dispute_auto_submit_by_email AS e, dispute_auto_submit_at AS t FROM accounts WHERE id = ?",
    )
    .get(id);
}

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

function render(
  settings: { enabled?: boolean; productDescription: string; shipsPhysical: boolean },
  actionData?: Record<string, unknown>,
) {
  const loaderData = { enabled: true, ...settings };
  const Stub = createRoutesStub([
    { path: "/settings/disputes", Component: () => createElement(Page, { loaderData, actionData }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/disputes"] }));
}

describe("S32 THE WRITER: three columns, pinned to the account", () => {
  it("writes the description and the toggles, and records who opted in to auto-submit", async () => {
    const result = await applyDisputeSettings(
      db,
      "a1",
      { productDescription: "  Handmade candles  ", shipsPhysical: true, autoSubmit: true },
      ACTOR,
    );
    expect(result.ok).toBe(true);
    expect(columns("a1")).toEqual({ d: "Handmade candles", s: 1, a: 1 });
    expect(optIn("a1")).toEqual({ u: "u1", e: "owner@a1.test", t: 5000 });
    expect(columns("a2")).toEqual({ d: null, s: null, a: null });

    // A later save keeps the original opt-in; turning it off clears it.
    await applyDisputeSettings(db, "a1", { productDescription: "", shipsPhysical: true, autoSubmit: true }, {
      userId: "u2",
      email: "other@a1.test",
      now: new Date(9000),
    });
    expect(optIn("a1")).toEqual({ u: "u1", e: "owner@a1.test", t: 5000 });
    await applyDisputeSettings(db, "a1", { productDescription: "", shipsPhysical: true, autoSubmit: false }, ACTOR);
    expect(columns("a1")).toMatchObject({ a: 0 });
    expect(optIn("a1")).toEqual({ u: null, e: null, t: null });
  });

  it("a description past Stripe's evidence limit is refused and nothing is written", async () => {
    const result = await applyDisputeSettings(
      db,
      "a1",
      { productDescription: "x".repeat(20_001), shipsPhysical: true, autoSubmit: true },
      ACTOR,
    );
    expect(result).toEqual({ ok: false, error: DISPUTE_PRODUCT_DESCRIPTION_ERROR });
    expect(columns("a1")).toEqual({ d: null, s: null, a: null });
  });
});

describe("S32 THE READERS: NULL is off and empty, as Recova's ?? false and ?? ''", () => {
  it("an account that never saved reads as blank and off", async () => {
    expect(await readDisputeSettings(db, "a1")).toEqual({
      enabled: true,
      productDescription: "",
      shipsPhysical: false,
      autoSubmit: false,
    });
    expect(await readDisputeProductDescription(db, "a1")).toBeNull();
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

describe("THE DISPUTES SWITCH (gap 7): off means intake creates no dispute", () => {
  it("off: the page shows the off line, the webhook commits only its claim, the import writes nothing", async () => {
    await applyDisputesEnabled(db, "a1", { enabled: false });
    expect(await readDisputeSettings(db, "a1")).toMatchObject({ enabled: false });
    expect((await readDisputeSettings(db, "a2")).enabled).toBe(true);

    const html = render({ enabled: false, productDescription: "", shipsPhysical: false });
    expect(html).toContain("Enable Disputes above to configure auto-submit, product description, and shipping settings.");
    expect(html).not.toContain("Save changes");

    const claim = {
      stripeEventId: "evt_1",
      eventType: "charge.dispute.created",
      accountId: "a1",
      receivedAt: new Date(1000),
      payload: {},
    };
    const outcome = await handleStampDispute(
      { env: {} as Env, accountId: "a1", connectionId: "c1", claim, idempotencyKey: "evt_1" } as never,
      { kind: "stamp_dispute", stripeDisputeId: "dp_1", chargeId: "ch_1" } as never,
    );
    expect(outcome).toEqual({ status: "ignored", reason: "disputes_disabled" });
    expect(harness.moneyWrites).toEqual([[expect.anything()]]); // the claim, and no dispute row

    expect(await importDisputeFromStripe({} as Env, "a1", "dp_1", new Date())).toEqual({
      status: "disputes_disabled",
    });
  });
});

