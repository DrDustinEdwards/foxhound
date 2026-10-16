import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { accounts } from "~/db/schema";
import { PLATFORM_LINKS } from "~/lib/nav/manifest";
import {
  LOOKBACK_DEFAULT,
  LOOKBACK_OPTIONS,
  isDigestEnabled,
  normalizeLookback,
  readAuditSettings,
} from "~/lib/settings/audit-settings";

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

const ROUTE = readFileSync("app/routes/app/settings/audit.tsx", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ROUTE_CODE = strip(ROUTE);

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

describe("315: NULL is OFF, which is legacy's own read behaviour", () => {
  it("a NULL row renders the digest OFF and the lookback at 90", () => {
    expect(readAuditSettings({ auditLookbackDays: null, auditAutoRun: null })).toEqual({
      lookbackDays: 90,
      autoRun: false,
    });
  });

  it("THE CRON-FACING READ treats NULL and false identically as off", () => {
    // Session 25 halted because nothing could set this column. The cron (Session
    // 27) must read "on" the same way the page writes it, or the two disagree
    // about NULL and the halt repeats in a subtler form.
    expect(isDigestEnabled(null)).toBe(false);
    expect(isDigestEnabled(undefined)).toBe(false);
    expect(isDigestEnabled(false)).toBe(false);
    expect(isDigestEnabled(true)).toBe(true);
  });

  it("the LOADER reads a NULL account as off, through the real query", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, {});
    const result = await loader({ context: ctx() } as never);
    expect(result).toEqual({ lookbackDays: 90, autoRun: false });
  });
});

describe("315: the lookback bound is legacy's, enforced server-side", () => {
  it("carries legacy's four options in legacy's order", () => {
    expect([...LOOKBACK_OPTIONS]).toEqual([30, 60, 90, 180]);
    expect(LOOKBACK_DEFAULT).toBe(90);
  });

  it("clamps anything outside the set to 90, as legacy's safeLookback does", () => {
    expect(normalizeLookback(30)).toBe(30);
    expect(normalizeLookback("180")).toBe(180);
    expect(normalizeLookback(45)).toBe(90);
    expect(normalizeLookback(0)).toBe(90);
    expect(normalizeLookback(-1)).toBe(90);
    expect(normalizeLookback("nonsense")).toBe(90);
    expect(normalizeLookback(null)).toBe(90);
    expect(normalizeLookback(999999)).toBe(90);
  });
});

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

  it("turning it back OFF writes false, not NULL", async () => {
    // False and NULL both read as off, but a merchant who explicitly turned it
    // off should be distinguishable from one who never touched it.
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, { auditAutoRun: true, auditLookbackDays: 30 });

    await post({ audit_lookback_days: "30", audit_auto_run: "false" });

    const rows = await db.select().from(accounts);
    expect(rows[0].auditAutoRun).toBe(false);
    expect(isDigestEnabled(rows[0].auditAutoRun)).toBe(false);
  });

  it("THE SERVER CLAMP: a posted out-of-set lookback is stored as 90", async () => {
    // Legacy clamps on RENDER and posts the clamped value, which is a
    // client-side guarantee only. An action takes whatever is posted, so the
    // clamp moved one layer deeper. A plant that removes it fails here.
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, {});

    await post({ audit_lookback_days: "9999", audit_auto_run: "false" });

    expect((await db.select().from(accounts))[0].auditLookbackDays).toBe(90);
  });

  it("anything other than the string 'true' is off", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seedAccount(db, { auditAutoRun: true });
    await post({ audit_lookback_days: "90", audit_auto_run: "on" });
    expect((await db.select().from(accounts))[0].auditAutoRun).toBe(false);
  });
});

describe("315: legacy's treatment and placement", () => {
  it("carries legacy's copy verbatim, except the one clause 316's session ruled out", () => {
    expect(ROUTE).toContain("Lookback period");
    expect(ROUTE).toContain("How far back we look when calculating your audit.");
    expect(ROUTE).toContain("Monthly audit digest");
    expect(ROUTE).toContain("On the 1st of each month, we run a fresh audit and email you a comparison");
    expect(ROUTE).toContain("Lookback period and monthly digest options.");
  });

  it("DOES NOT promise an AI-written digest, which nothing can produce", () => {
    // Divergence 5, ruled by Dustin in 316's session. Legacy's digest leads with
    // runAudit()'s aiSummary; Foxhound's audit entry point produces no summary
    // and ANTHROPIC_API_KEY has no credit (core.md blocker 2). Asserted against
    // the COMMENT-STRIPPED source, because the comment recording the ruling
    // necessarily quotes the clause it removed.
    expect(ROUTE_CODE).not.toContain("written by AI");
    expect(ROUTE_CODE).toContain("versus the prior month. No extra charge.");
  });

  it("draws the card, the choices and the toggle from Capsomer (J35, Q10)", () => {
    // Legacy's hand-rolled card, pills and Toggle geometry gave way to
    // Capsomer's panel, segmented control and switch under J35. The rendered
    // checks live in settings-audit-j35.test.ts; this keeps the hand-built
    // versions from coming back.
    expect(ROUTE_CODE).toContain('from "capsomer/react/segmented"');
    expect(ROUTE_CODE).toContain('from "capsomer/react/switch"');
    expect(ROUTE_CODE).toContain('className="cap-panel"');
    expect(ROUTE_CODE).not.toContain("rounded-[12px]");
    expect(ROUTE_CODE).not.toContain("translateX(16px)");
  });

  it("posts BOTH values under legacy's field names", () => {
    expect(ROUTE_CODE).toContain('name="audit_lookback_days"');
    expect(ROUTE_CODE).toContain('name="audit_auto_run"');
  });

  it("is DEMO-GUARDED like every other settings write", () => {
    // Legacy has no demo settings surface at all (its demo tree is
    // /recovery/demo/*), so there is no legacy demo behaviour to port. Foxhound's
    // own established pattern governs, and it is the same component every other
    // settings form uses.
    // STRENGTHENED after its plant did NOT bite. This read
    // `toContain("DemoGuardedForm")`, which matched the surviving IMPORT line
    // even with the JSX swapped for a plain Form: it asserted the component was
    // imported, not that it wraps the write. The usage is what matters.
    expect(ROUTE_CODE).toMatch(/<DemoGuardedForm\s+method="post"/);
    expect(ROUTE_CODE).toContain("</DemoGuardedForm>");
    expect(ROUTE_CODE).not.toMatch(/<Form\s+method="post"/);
  });

  it("IS REACHABLE: listed in the nav manifest, the only path to it", () => {
    // Legacy lists Audit in the settings sidebar's Products group. Foxhound has
    // no sidebar, so this is the same mechanism that reaches /settings/team. A
    // page nobody can navigate to is the defect this row existed to fix.
    const audit = PLATFORM_LINKS.find((l) => l.to === "/settings/audit");
    expect(audit, "no navigation path to /settings/audit").toBeDefined();
    expect(audit?.label).toBe("Audit settings");
  });

  it("REGRESSION GUARD: Team is still listed too", () => {
    // The manifest edit must not displace the link it sits beside.
    expect(PLATFORM_LINKS.some((l) => l.to === "/settings/team")).toBe(true);
  });

  it("REGRESSION GUARD: no column DEFAULT was added by this build", () => {
    // 315 required the live rows stay NULL-off. Legacy agrees: its page defaults
    // in the READ. A migration adding DEFAULT 1 would opt every existing account
    // into a monthly email nobody chose.
    const migrations = readFileSync("drizzle/migrations/0000_init_foxhound_schema.sql", "utf8");
    expect(migrations).toContain("`audit_auto_run` integer");
    expect(migrations).not.toContain("`audit_auto_run` integer DEFAULT");
  });
});
