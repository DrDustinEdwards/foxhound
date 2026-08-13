import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts } from "~/db/schema";
import { LIVE_SENDS_DISABLED_ERROR, liveSendsEnabled } from "~/lib/email/dispatch";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// THE LIVE-SEND FLAG, ratified 2026-08-09 in commit 9766ff5 and landed by ruling
// 268 as Session D's own deliverable.
//
// What it replaces is the reason it matters: nothing in this codebase ever CHOSE
// to be a send kill switch. What actually stopped mail leaving was an unset
// PHYSICAL_ADDRESS secret throwing a CAN-SPAM error inside buildEmailMessage, a
// compliance guard doing duty as a switch nobody selected and one populated env
// var away from every eligible account mailing at once.
//
// The column is asserted against the REAL committed migrations, so what proves
// "defaults OFF" is the actual DEFAULT false NOT NULL in 0013, not a TypeScript
// default that would never reach D1.

const DISPATCH = readFileSync("app/lib/email/dispatch.ts", "utf8");

function seedAccount(over: { liveSendsEnabled?: boolean } = {}) {
  const { sqlite, db } = createInMemoryDb();
  runStatement(
    sqlite,
    db.insert(accounts).values({ id: "acc_1", name: "Acme", ...over }),
  );
  return { sqlite, db };
}

describe("live-send flag: the column defaults OFF against the real schema", () => {
  it("a freshly created account cannot send live mail", async () => {
    // The insert names no flag at all, exactly as every existing account row does,
    // so this is the migration's own DEFAULT false NOT NULL answering.
    const { db } = seedAccount();
    expect(await liveSendsEnabled(db, "acc_1")).toBe(false);
  });

  it("an account switched ON can send", async () => {
    const { sqlite, db } = seedAccount();
    runStatement(
      sqlite,
      db.update(accounts).set({ liveSendsEnabled: true }).where(eq(accounts.id, "acc_1")),
    );
    expect(await liveSendsEnabled(db, "acc_1")).toBe(true);
  });

  it("FAILS CLOSED for an unknown account", async () => {
    const { db } = seedAccount();
    expect(await liveSendsEnabled(db, "acc_does_not_exist")).toBe(false);
  });

  it("FAILS CLOSED for a job carrying no account at all", async () => {
    // EmailJob.accountId is nullable in the type. No live caller passes null
    // (measured 2026-08-12: processEmailJob has exactly two callers, the engine's
    // defaultSend with a non-null context and the queue consumer that nothing
    // enqueues to), so this branch exists so it can never become a bypass.
    const { db } = seedAccount();
    expect(await liveSendsEnabled(db, null)).toBe(false);
  });
});

describe("live-send flag: where the gate sits", () => {
  // 9766ff5 is specific about the site: "a per-account live flag, defaulting OFF
  // ... belongs in this function", checked "before sendEmail". Source-shape
  // assertions, stated as such: they pin ORDERING, which the DB tests above
  // cannot see.
  it("is checked inside processEmailJob, after suppression and before the send", () => {
    const body = DISPATCH.slice(DISPATCH.indexOf("export async function processEmailJob"));
    const suppression = body.indexOf("isSuppressed");
    const gate = body.indexOf("liveSendsEnabled");
    const send = body.indexOf("await sendEmail");
    expect(suppression).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(suppression);
    expect(send).toBeGreaterThan(gate);
  });

  it("logs the block to email_sends rather than dropping it silently", () => {
    expect(DISPATCH).toContain('status: "blocked"');
    expect(DISPATCH).toContain("LIVE_SENDS_DISABLED_ERROR");
    expect(LIVE_SENDS_DISABLED_ERROR).toBe("live sends are disabled for this account");
  });

  it("reports a block as retryable, never as a successful send", () => {
    // Reporting ok would land the step on `email_sent` with nothing sent. The
    // consequence is stated in the module: a flag-off account's steps back off and
    // eventually go terminal, which is why a later hardening pass may prefer this
    // gate in the account-eligibility predicate.
    // Whitespace-agnostic on purpose: this file is CRLF, and a bare-LF anchor is
    // the exact silent-miss 267 codified. The matcher is checked before the
    // subject (239).
    expect(DISPATCH).toMatch(
      /return\s*\{[^}]*status:\s*"blocked"[^}]*retryable:\s*true[^}]*\}/,
    );
  });
});

describe("live-send flag: the demo account", () => {
  it("is blocked THREE times over, and the flag is the third", () => {
    // Measured rather than assumed, per the brief. The demo seeder sets
    // processingPaused true and the id carries DEMO_ACCOUNT_ID_PREFIX, so
    // accountProcessingEligibleCondition excludes it from the cron twice before
    // the flag is ever read; the app-shell middleware 405s every mutating demo
    // request; and the flag now defaults OFF for it like every other row.
    const seed = readFileSync("app/lib/demo/seed.ts", "utf8");
    expect(seed).toContain("processingPaused: true");
    const tick = readFileSync("app/lib/cron/recovery-tick.ts", "utf8");
    expect(tick).toContain("DEMO_ACCOUNT_ID_PREFIX");
    expect(tick).toContain("eq(accounts.processingPaused, false)");
    // And the seeder does NOT switch the flag on, so the demo stays blocked.
    expect(seed).not.toContain("liveSendsEnabled");
  });
});
