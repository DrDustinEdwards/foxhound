import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments } from "~/db/schema";
import {
  BULK_ACTION_CONCURRENCY,
  BULK_ACTION_CONFIRM_THRESHOLD,
  BULK_ACTION_MAX_PER_SUBMISSION,
} from "~/lib/constants";
import { mapWithConcurrency, runBulkAction } from "~/lib/recovery/bulk-actions.server";
import {
  failedIds,
  isBulkRefusal,
  orderForDisplay,
  toItemResult,
} from "~/lib/recovery/bulk-results";
import {
  manualActionIdempotencyKey,
  type ManualActionCommit,
  type ResendDeps,
  type TriggerDeps,
} from "~/lib/recovery/manual-actions.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S6 bulk actions, Session 2 (274 decisions one, four and five).
//
// The layer under test is FAN-OUT AND AGGREGATION ONLY. Every per-payment
// semantic already belongs to dispatchManualAction and Session B proved it, so
// what is pinned here is what the bulk layer adds: that the client's id list is
// re-derived rather than trusted, that nothing is dropped on the way in or the
// way out, that the ceiling refuses instead of truncating, and that the failures
// come back nameable one by one rather than as a count.
//
// The end-to-end cases run the REAL dispatcher against a real in-memory SQLite
// with the committed migrations applied, so the aggregation is proven over
// actual gate outcomes rather than over stubbed ones.

const now = new Date("2026-08-13T00:00:00.000Z");

const ROUTE = readFileSync("app/routes/app/recovery/payments/index.tsx", "utf8");

/** acc_1 owns fp_active_a, fp_active_b, fp_recovered. acc_2 owns fp_theirs, so
 *  an id from another account is a genuine cross-account probe rather than a
 *  made up string. */
function seed() {
  const { sqlite, db } = createInMemoryDb();
  for (const [id, name] of [
    ["acc_1", "Mine"],
    ["acc_2", "Theirs"],
  ] as const) {
    runStatement(sqlite, db.insert(accounts).values({ id, name }));
  }
  const rows: [string, string, string][] = [
    ["fp_active_a", "acc_1", "active"],
    ["fp_active_b", "acc_1", "active"],
    ["fp_recovered", "acc_1", "recovered"],
    ["fp_theirs", "acc_2", "active"],
  ];
  for (const [id, accountId, status] of rows) {
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id,
        accountId,
        stripeEventId: `evt_${id}`,
        stripeInvoiceId: `in_${id}`,
        stripeCustomerId: `cus_${id}`,
        customerEmail: "customer@example.com",
        amountCents: 4200,
        currency: "usd",
        declineCategory: "soft",
        status,
        detectedAt: now,
      }),
    );
  }
  return { sqlite, db };
}

/** The same in-transaction commit Session B uses: the batch's real compiled
 *  statements against the real schema, recording every key it was handed. */
function inMemoryCommit(sqlite: Database.Database, db: Db, keys: string[] = []): ManualActionCommit {
  return async (_accountId, idempotencyKey, build) => {
    keys.push(idempotencyKey);
    const batch = build(db);
    sqlite.transaction(() => {
      for (const statement of batch) runStatement(sqlite, statement);
    })();
    return { applied: true };
  };
}

/** Cancel sends nothing and triggers nothing. These seams throw, so a bulk Stop
 *  recovery that reached a mailer or an executor fails the test loudly instead
 *  of passing quietly. This is also the assertion behind the claim that
 *  SEND-PRECEDES-PERSIST (268) does not apply to this intent: there is no send
 *  to precede anything. */
function loudTriggerDeps(): TriggerDeps {
  return {
    loadStep: async () => {
      throw new Error("loadStep called unexpectedly");
    },
    runRetry: async () => {
      throw new Error("runRetry called unexpectedly");
    },
    runEmail: async () => {
      throw new Error("runEmail called unexpectedly");
    },
  };
}

function loudResendDeps(): ResendDeps {
  return {
    send: async () => {
      throw new Error("resend.send called unexpectedly");
    },
  };
}

function statusOf(sqlite: Database.Database, id: string): string {
  return (sqlite.prepare("select status from failed_payments where id = ?").get(id) as {
    status: string;
  }).status;
}

function run(
  sqlite: Database.Database,
  db: Db,
  ids: string[],
  keys: string[] = [],
  accountId = "acc_1",
) {
  return runBulkAction({
    db,
    accountId,
    intent: "cancel",
    ids,
    commit: inMemoryCommit(sqlite, db, keys),
    trigger: loudTriggerDeps(),
    resend: loudResendDeps(),
    now,
  });
}

describe("bulk actions: a mixed selection is answered payment by payment", () => {
  it("stops what it can and names why it could not stop the rest", async () => {
    const { sqlite, db } = seed();
    const outcome = await run(sqlite, db, [
      "fp_active_a",
      "fp_recovered",
      "fp_theirs",
      "fp_missing",
      "fp_active_b",
    ]);

    expect(isBulkRefusal(outcome)).toBe(false);
    if (isBulkRefusal(outcome)) return;

    // Input order, one result per submitted id, nothing dropped either way.
    expect(outcome.results.map((r) => r.id)).toEqual([
      "fp_active_a",
      "fp_recovered",
      "fp_theirs",
      "fp_missing",
      "fp_active_b",
    ]);
    expect(outcome.results.map((r) => r.reason)).toEqual([
      null,
      "not_active",
      // Another account's payment is NOT FOUND, never "forbidden": the account
      // scoped read cannot see it, so bulk leaks no more than the single path.
      "not_found",
      "not_found",
      null,
    ]);
    expect(outcome.intent).toBe("cancel");
  });

  it("commits only the payments that passed, and leaves the others alone", async () => {
    const { sqlite, db } = seed();
    await run(sqlite, db, ["fp_active_a", "fp_recovered", "fp_theirs", "fp_active_b"]);

    expect(statusOf(sqlite, "fp_active_a")).toBe("cancelled");
    expect(statusOf(sqlite, "fp_active_b")).toBe("cancelled");
    expect(statusOf(sqlite, "fp_recovered")).toBe("recovered");
    // The cross-account id is the one that matters: a bulk write must not reach
    // outside the account however the ids were assembled in the browser.
    expect(statusOf(sqlite, "fp_theirs")).toBe("active");
  });

  it("adds NO key scheme: each payment keeps the key the single path assigns", async () => {
    const { sqlite, db } = seed();
    const keys: string[] = [];
    await run(sqlite, db, ["fp_active_a", "fp_active_b"], keys);

    expect(keys).toEqual([
      manualActionIdempotencyKey("cancel", "fp_active_a"),
      manualActionIdempotencyKey("cancel", "fp_active_b"),
    ]);
    // No batch-level, submission-level or fan-out-level key anywhere.
    expect(keys.some((k) => k.includes("bulk"))).toBe(false);
  });

  it("submitting the same id twice does it once, not twice", async () => {
    const { sqlite, db } = seed();
    const keys: string[] = [];
    const outcome = await run(sqlite, db, ["fp_active_a", "fp_active_a"], keys);

    expect(isBulkRefusal(outcome)).toBe(false);
    if (isBulkRefusal(outcome)) return;
    expect(outcome.results).toHaveLength(1);
    expect(keys).toHaveLength(1);
  });

  it("re-running over an already stopped payment answers, it does not throw", async () => {
    const { sqlite, db } = seed();
    await run(sqlite, db, ["fp_active_a"]);
    const again = await run(sqlite, db, ["fp_active_a"]);

    expect(isBulkRefusal(again)).toBe(false);
    if (isBulkRefusal(again)) return;
    // Already cancelled is no longer active, which is the gate that answers.
    expect(again.results).toEqual([{ id: "fp_active_a", ok: false, reason: "not_active" }]);
  });
});

describe("bulk actions: the ceiling refuses, it never truncates (274 decision four)", () => {
  it("refuses one over the ceiling and touches nothing", async () => {
    const { sqlite, db } = seed();
    const keys: string[] = [];
    const ids = Array.from({ length: BULK_ACTION_MAX_PER_SUBMISSION + 1 }, (_, i) => `fp_${i}`);
    const outcome = await run(sqlite, db, ids, keys);

    expect(isBulkRefusal(outcome)).toBe(true);
    if (!isBulkRefusal(outcome)) return;
    expect(outcome.refused).toBe("over_ceiling");
    // The exact number submitted, so the surface can say it rather than say
    // "too many", and the ceiling travels with it.
    expect(outcome.submitted).toBe(BULK_ACTION_MAX_PER_SUBMISSION + 1);
    expect(outcome.ceiling).toBe(BULK_ACTION_MAX_PER_SUBMISSION);
    // Not one write, not the first hundred: the whole submission is refused.
    expect(keys).toHaveLength(0);
  });

  it("accepts exactly the ceiling, so the boundary is not off by one", async () => {
    const { sqlite, db } = seed();
    const ids = Array.from({ length: BULK_ACTION_MAX_PER_SUBMISSION }, (_, i) => `fp_${i}`);
    const outcome = await run(sqlite, db, ids);

    expect(isBulkRefusal(outcome)).toBe(false);
    if (isBulkRefusal(outcome)) return;
    expect(outcome.results).toHaveLength(BULK_ACTION_MAX_PER_SUBMISSION);
  });

  it("refuses an empty submission rather than reporting a successful nothing", async () => {
    const { sqlite, db } = seed();
    const outcome = await run(sqlite, db, []);

    expect(isBulkRefusal(outcome)).toBe(true);
    if (!isBulkRefusal(outcome)) return;
    expect(outcome.refused).toBe("empty");
    expect(outcome.submitted).toBe(0);
  });

  it("the ceiling is enforced on the SERVER, not only in the dialog", async () => {
    // The dialog is the reason a merchant does not hit this. The server check is
    // the reason a hand crafted POST does not either, and only the second one is
    // a guarantee. Both exist; this asserts the second.
    const { sqlite, db } = seed();
    const ids = Array.from({ length: 500 }, (_, i) => `fp_${i}`);
    const outcome = await run(sqlite, db, ids);
    expect(isBulkRefusal(outcome)).toBe(true);
  });
});

describe("bulk actions: the fan-out is bounded and order-preserving", () => {
  it("never exceeds the cap and still returns results in INPUT order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    const out = await mapWithConcurrency(items, BULK_ACTION_CONCURRENCY, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Longer waits for the earlier items, so completion order is not input
      // order and an implementation that pushed as it finished would be caught.
      await new Promise((resolve) => setTimeout(resolve, n < 10 ? 4 : 0));
      inFlight -= 1;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(BULK_ACTION_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(out).toEqual(items.map((n) => n * 2));
  });

  it("handles fewer items than the cap without spawning idle workers", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([1, 2], BULK_ACTION_CONCURRENCY, async (n) => {
      calls += 1;
      return n;
    });
    expect(out).toEqual([1, 2]);
    expect(calls).toBe(2);
  });
});

describe("bulk actions: the surface itemises, and failures come first", () => {
  const mixed = [
    { id: "a", ok: true, reason: null },
    { id: "b", ok: false, reason: "not_active" as const },
    { id: "c", ok: true, reason: null },
    { id: "d", ok: false, reason: "write_failed" as const },
  ];

  it("orders failures first, each group in input order", () => {
    expect(orderForDisplay(mixed).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps every payment in the output, so nothing hides behind a count", () => {
    expect(orderForDisplay(mixed)).toHaveLength(mixed.length);
  });

  it("failedIds is exactly the set that stays selected", () => {
    expect(failedIds(mixed)).toEqual(["b", "d"]);
  });

  it("an outcome this intent should not produce is reported, never swallowed", () => {
    const odd = toItemResult("x", { ok: false, reason: "no_pending_step" });
    expect(odd).toEqual({ id: "x", ok: false, reason: "unexpected" });
  });
});

describe("bulk actions: the list route wires exactly one intent", () => {
  it("posts to its own action with the intent named on the submit control", () => {
    expect(ROUTE).toContain("export async function action({ context, request }: Route.ActionArgs)");
    expect(ROUTE).toContain('const intent = String(form.get("intent") ?? "");');
    expect(ROUTE).toContain('const ids = form.getAll("ids").map(String).filter(Boolean);');
    expect(ROUTE).toContain("await runBulkAction({");
  });

  it("submits the ACTIONABLE set, so the count on the label is the set sent", () => {
    // The gate-versus-submit repair (274 decision two) only holds if the hidden
    // inputs come from `actionable` and not from the whole stored selection.
    expect(ROUTE).toContain("{actionable.map((id) => (");
    expect(ROUTE).toContain('<input key={id} type="hidden" name="ids" value={id} />');
  });

  it("Trigger next step and Mark recovered stay inert for Session 3", () => {
    const bar = ROUTE.slice(ROUTE.indexOf('aria-label="Bulk actions"'));
    const start = bar.indexOf("{actionable.length > 0 ? (");
    const end = bar.indexOf("Clear", start);
    const block = bar.slice(start, end);
    // Two unconditionally disabled buttons, and neither carries an onClick.
    expect(block.match(/^\s+disabled$/gm)).toHaveLength(2);
    expect(block).toContain("Trigger next step ({actionable.length})");
    expect(block).toContain("Mark recovered");
    // The third is the wired one: a submit carrying the cancel intent.
    expect(block).toContain('value="cancel"');
    expect(block).toContain('type={needsConfirm || overCeiling ? "button" : "submit"}');
  });

  it("names the exact count and the action above the threshold, and states the ceiling", () => {
    expect(BULK_ACTION_CONFIRM_THRESHOLD).toBe(25);
    expect(BULK_ACTION_MAX_PER_SUBMISSION).toBe(100);
    expect(ROUTE).toContain("const needsConfirm = actionable.length > BULK_ACTION_CONFIRM_THRESHOLD;");
    expect(ROUTE).toContain("const overCeiling = actionable.length > BULK_ACTION_MAX_PER_SUBMISSION;");
    expect(ROUTE).toContain("Stop recovery for {actionable.length} payments?");
    expect(ROUTE).toContain("most {BULK_ACTION_MAX_PER_SUBMISSION} at a time.");
    expect(ROUTE).toContain("Nothing has been changed, and nothing will be trimmed to fit.");
  });

  it("the result surface persists until dismissed and has no timer", () => {
    expect(ROUTE).toContain('aria-label="Bulk action result"');
    expect(ROUTE).toContain("onClick={() => setDismissedFor(bulk)}");
    // No auto-dismiss anywhere on this route: 274 decision one is explicit that
    // the itemisation waits for the merchant.
    expect(ROUTE).not.toContain("setTimeout");
  });

  it("the failed ids are the selection once a response lands", () => {
    expect(ROUTE).toContain(
      "sel.from !== bulk && applied ? new Set(failedIds(applied.results)) : sel.ids;",
    );
  });

  it("the demo gate from Session 1 is untouched", () => {
    expect(ROUTE).toContain("{!isDemo && selectionCount > 0 ? (");
    expect(ROUTE).toContain("colSpan={isDemo ? 6 : 7}");
  });
});
