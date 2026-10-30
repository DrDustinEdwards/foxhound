import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 315: S30, /settings/audit, built. It was DEFECT-OPEN with foxhound
// source "none", and Session 25 HALTED the monthly digest cron because of it:
// nothing could set audit_auto_run, so a cron gated on it would have iterated
// zero accounts forever. This page is what makes the column settable.
//
// LEGACY IS THE SPEC, read whole at blob shas per 260: page.tsx 18e6a384,
// AuditForm.tsx 5bf81c10, AuditSection.tsx 58c5abce, Toggle.tsx 0ebdd395,
// SettingsSidebar.tsx e1a283ec.
//
// COVERAGE BOUND (246): there is no DOM test environment in this repo, so the
// rendered controls are asserted by SOURCE and the DECISIONS are asserted
// behaviourally through the real loader and action. What is NOT proven here is
// that React paints the toggle; that rests on the demo probe.


const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
const { loader, action } = await import("~/routes/app/settings/audit");

const ACCOUNT = "acct_315";

function ctx() {
  return {
    get: (key: unknown) => {
      const name = String((key as { name?: string })?.name ?? "");
      if (name.includes("cloudflare")) return { env: {} as Env };
      return { membership: { accountId: ACCOUNT } };
    },
  } as never;
}

async function seedAccount(db: ReturnType<typeof createInMemoryDb>["db"], row: Record<string, unknown>) {
  await db.insert(accounts).values({ id: ACCOUNT, name: "Acme", createdAt: new Date(), ...row });
}

describe("315: the toggle round-trips through the REAL action", () => {
  function post(fields: Record<string, string>) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    return action({ request: new Request("http://x/settings/audit", { method: "POST", body }), context: ctx() } as never);
  }

  it("turning the digest ON writes true, and the loader reads it back", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, {});

    await post({ audit_lookback_days: "180", audit_auto_run: "true" });

    const rows = await db.select().from(accounts);
    expect(rows[0].auditAutoRun).toBe(true);
    expect(rows[0].auditLookbackDays).toBe(180);
    expect(await loader({ context: ctx() } as never)).toEqual({
      lookbackDays: 180,
      autoRun: true,
    });
  });
});
