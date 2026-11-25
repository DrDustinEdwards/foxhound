import { describe, expect, it, vi } from "vitest";

import { webhookEvents } from "~/db";
import { listWebhookEvents } from "~/lib/admin/webhooks.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const NOW = Date.now();
const MIN = 60 * 1000;

interface Filters {
  type: string;
  errorsOnly: boolean;
  pendingOnly: boolean;
  page: number;
}
interface EventRow {
  id: string;
  eventType: string;
  accountId: string | null;
  receivedAt: Date;
  processed: boolean;
  errorMessage: string | null;
  payload: unknown;
}
interface ListResult {
  events: EventRow[];
  total: number;
  page: number;
  pageCount: number;
}

async function list(db: unknown, filters: Partial<Filters>): Promise<ListResult> {
  const full: Filters = { type: "", errorsOnly: false, pendingOnly: false, page: 1, ...filters };
  return listWebhookEvents(db as never, full) as unknown as Promise<ListResult>;
}

/** 120 events, newest first by index: every third an error, every fifth an
 *  unknown account, every seventh still waiting. Types rotate through three. */
async function seed(n = 120) {
  const { db } = createInMemoryDb();
  const types = [
    "invoice.payment_failed",
    "Charge.Dispute.Created",
    "customer.subscription.updated",
  ];
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `we_${String(i).padStart(3, "0")}`,
    stripeEventId: `evt_${i}`,
    eventType: types[i % 3],
    receivedAt: new Date(NOW - i * MIN),
    accountId: i % 5 === 0 ? null : `acct_${i % 4}`,
    processed: i % 7 !== 0,
    errorMessage: i % 3 === 1 ? `boom ${i}` : null,
    payload: { id: `evt_${i}`, type: types[i % 3], data: { object: { amount: i } } },
  }));
  await db.insert(webhookEvents).values(rows);
  return db;
}

describe("listWebhookEvents", () => {
  it("keeps the page inside its bounds", async () => {
    const db = await seed();
    const past = await list(db, { page: 99 });
    expect(past.page).toBe(3);
    expect(past.events[0].id).toBe("we_100");
    expect((await list(db, { page: 0 })).page).toBe(1);
  });

  it("filters through Drizzle's like, where a typed wildcard only widens the match", async () => {
    const db = await seed();
    expect((await list(db, { type: "payment%failed" })).total).toBe(40);
    expect((await list(db, { type: "no.such.event" })).total).toBe(0);
  });

  it("shows only the events with an error, or only the waiting ones, and both together", async () => {
    const db = await seed();
    const errors = await list(db, { errorsOnly: true });
    expect(errors.total).toBe(40);
    expect(errors.events.every((e) => e.errorMessage !== null)).toBe(true);

    const pending = await list(db, { pendingOnly: true });
    expect(pending.total).toBe(18);
    expect(pending.events.every((e) => !e.processed)).toBe(true);

    const both = await list(db, { errorsOnly: true, pendingOnly: true, type: "dispute" });
    expect(
      both.events.every(
        (e) => e.errorMessage !== null && !e.processed && /dispute/i.test(e.eventType),
      ),
    ).toBe(true);
    expect(both.total).toBe(both.events.length);
  });
});
