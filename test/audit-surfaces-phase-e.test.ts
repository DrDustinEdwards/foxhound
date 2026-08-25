import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAudit, type AuditInputs, type ScopeOutcome } from "~/lib/audit/engine";
import { SCOPE_UNREAD, toStoredAuditRun } from "~/lib/audit/render";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 70, PHASE (e): the two authenticated audit surfaces.
//
// THE PROPERTY THESE PLANTS EXIST FOR is the one that has now survived four
// hand-offs: a scope that could not be read must never render as a zero. The
// engine gave it a status (362 ruling 2), persistence stored it as NULL (364),
// and this is the layer where legacy loses it: its stored-run page maps every
// column with `?? 0`.
//
// PLANTS DRIVE THE REAL LOADERS (352), with two accounts in every fixture.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { saveAuditRun } = await import("~/lib/audit/persist.server");
const history = await import("~/routes/app/audit/history");
const runPage = await import("~/routes/app/audit/run");

const RAN_AT = new Date("2026-08-25T09:00:00.000Z");
const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";

const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failedRead = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", ...o }) as unknown as Stripe.Invoice;
const dispute = (o: Record<string, unknown>) =>
  ({ amount: 0, currency: "usd", ...o }) as unknown as Stripe.Dispute;

function auditWith(over: Partial<AuditInputs> = {}, ranAt = RAN_AT) {
  return runAudit({
    stripeAccountId: "acct_stripe_x",
    lookbackDays: 90,
    ranAt,
    reads: {
      uncollectibleInvoices: ok<Stripe.Invoice>([]),
      openInvoices: ok<Stripe.Invoice>([]),
      subscriptions: ok<Stripe.Subscription>([]),
      disputes: ok<Stripe.Dispute>([]),
      cardUpdaterEvents: ok<Stripe.Event>([]),
      ...over,
    },
  });
}

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(id, id);
  }
});

function contextFor(accountId: string): unknown {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      }
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "user_1",
          email: "owner@alpha.test",
          membership: { memberId: "m", accountId, accountName: accountId, role: "owner" },
          memberships: [],
          activeAccountId: accountId,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  };
}

const save = (accountId: string, result = auditWith(), summary = "One. Two. Three.") =>
  saveAuditRun({} as Env, result, { accountId, isAuthenticated: true, summary, now: RAN_AT });

const loadHistory = (accountId: string) =>
  history.loader({
    context: contextFor(accountId),
    request: new Request("https://foxhoundapp.test/audit/history"),
    params: {},
  } as never) as Promise<{
    runs: {
      id: string;
      failedInvoicesCents: number | null;
      openDisputesCents: number | null;
      mrrCents: number | null;
    }[];
  }>;

const loadRun = (accountId: string, id: string) =>
  runPage.loader({
    context: contextFor(accountId),
    request: new Request("https://foxhoundapp.test/audit/runs/x"),
    params: { id },
  } as never);

describe("PLANT 1: the history surface", () => {
  it("lists an account's runs, newest first", async () => {
    await save(ACCOUNT_A, auditWith({}, new Date(RAN_AT.getTime() - 86_400_000)));
    const newest = await save(ACCOUNT_A);
    const { runs } = await loadHistory(ACCOUNT_A);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(newest);
  });

  it("IS EMPTY FOR AN ACCOUNT WITH NO RUNS, which is every account at this sha", async () => {
    // Nothing triggers a run yet: the on-demand flow is phase (f)'s OAuth and
    // the monthly one is (g)'s cron. The empty state is the state.
    expect((await loadHistory(ACCOUNT_A)).runs).toEqual([]);
  });

  it("NEVER SHOWS ANOTHER ACCOUNT'S RUNS", async () => {
    await save(ACCOUNT_B);
    await save(ACCOUNT_B);
    await save(ACCOUNT_A);
    expect((await loadHistory(ACCOUNT_A)).runs).toHaveLength(1);
    expect((await loadHistory(ACCOUNT_B)).runs).toHaveLength(2);
  });

  it("carries a NULL through to the loader rather than coalescing it", async () => {
    await save(ACCOUNT_A, auditWith({ subscriptions: failedRead("subs unavailable") }));
    const { runs } = await loadHistory(ACCOUNT_A);
    // MRR comes from the subscriptions read, so it is null, not 0.
    expect(runs[0].failedInvoicesCents).toBe(0);
    expect(runs[0].mrrCents).toBeNull();
  });
});

describe("PLANT 2: the stored-run surface", () => {
  it("reads one run and maps every scope", async () => {
    const id = await save(
      ACCOUNT_A,
      auditWith({
        uncollectibleInvoices: ok<Stripe.Invoice>([
          invoice({ amount_due: 25_000, last_finalization_error: { decline_code: "expired_card" } }),
        ]),
        disputes: ok<Stripe.Dispute>([dispute({ status: "needs_response", amount: 9_000 })]),
      }),
    );
    const { run } = (await loadRun(ACCOUNT_A, id)) as { run: ReturnType<typeof toStoredAuditRun> };
    expect(run.failedInvoices).toMatchObject({ count: 1, totalCents: 25_000 });
    expect(run.failedInvoices!.byCategory.expired).toBe(25_000);
    expect(run.disputes!.open).toEqual({ count: 1, totalCents: 9_000 });
    expect(run.health!.mrrCents).toBe(0);
    expect(run.summary).toBe("One. Two. Three.");
  });

  it("A SCOPE THAT COULD NOT BE READ ARRIVES AS null, never as a zero", async () => {
    // Legacy's own mapper is `row.open_disputes_count ?? 0`, which is exactly
    // the flattening 362 ruling 2 exists to stop. This is where it would happen.
    const id = await save(
      ACCOUNT_A,
      auditWith({
        disputes: failedRead("Could not read disputes from Stripe: rate limited"),
        subscriptions: failedRead("subs unavailable"),
      }),
    );
    const { run } = (await loadRun(ACCOUNT_A, id)) as { run: ReturnType<typeof toStoredAuditRun> };
    expect(run.disputes).toBeNull();
    expect(run.expiringCards).toBeNull();
    expect(run.pastDueSubscriptions).toBeNull();
    expect(run.health).toBeNull();
    // And a scope that WAS read still carries its numbers, including a real zero.
    expect(run.failedInvoices).toMatchObject({ count: 0, totalCents: 0 });
  });

  it("404s on another account's run id", async () => {
    const theirs = await save(ACCOUNT_B);
    await expect(loadRun(ACCOUNT_A, theirs)).rejects.toMatchObject({ status: 404 });
    await expect(loadRun(ACCOUNT_B, theirs)).resolves.toBeTruthy();
  });

  it("404s on an id that does not exist at all", async () => {
    await expect(loadRun(ACCOUNT_A, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("PLANT 3: the Card Updater's two nulls stay apart", () => {
  it("an advisory that did not fire is not a scope that was not read", async () => {
    const fired = await save(ACCOUNT_A, auditWith());
    const notRead = await save(
      ACCOUNT_A,
      auditWith({ cardUpdaterEvents: failedRead("events unavailable") }),
    );
    const a = (await loadRun(ACCOUNT_A, fired)) as { run: ReturnType<typeof toStoredAuditRun> };
    const b = (await loadRun(ACCOUNT_A, notRead)) as { run: ReturnType<typeof toStoredAuditRun> };
    expect(a.run.cardUpdater).toMatchObject({ eventsInWindow: 0, advisory: null });
    expect(b.run.cardUpdater).toBeNull();
  });
});

describe("PLANT 4: what these surfaces must NOT carry", () => {
  const source = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  const runSource = source("app/routes/app/audit/run.tsx");
  const historySource = source("app/routes/app/audit/history.tsx");
  // THE SECTIONS MOVED IN PHASE (f), and two assertions below moved with them.
  // Session 70 scoped them to run.tsx because it was the only renderer; the live
  // anonymous results page is the second, so the four sections were extracted to
  // one component module and these now assert against the place BOTH surfaces
  // read from. That is a strictly stronger check than the pair it replaces: it
  // could previously have passed on run.tsx while a second copy of the render
  // coalesced its nulls, which is exactly the drift the extraction prevents.
  const sectionsSource = source("app/components/audit/sections.tsx");

  it("no recoverable estimate, no platform medians, no recovery-rate bands", () => {
    // Three legacy renders, all already NOT PORTABLE: the estimate built from
    // AUDIT_RECOVERY_ESTIMATE_PCT, the two "Platform median" churn figures, and
    // the >=36/21-35 recovery-rate colour bands.
    for (const forbidden of [
      "Recoverable estimate",
      "AUDIT_RECOVERY_ESTIMATE_PCT",
      "Platform median",
      "platform average recovery rate",
    ]) {
      expect(runSource, `${forbidden} reached the run page`).not.toContain(forbidden);
    }
  });

  it("NO SECOND WRITER FOR S30'S TWO COLUMNS", () => {
    // Legacy renders its AuditSettingsForm inline here. Foxhound writes both
    // columns at /settings/audit, and a second form would be 336 binding 3's
    // defect. The page links to the one that exists.
    for (const column of ["auditLookbackDays", "auditAutoRun", "audit_lookback_days"]) {
      expect(historySource, `${column} is written here`).not.toContain(column);
    }
    expect(historySource).toContain('to="/settings/audit"');
  });

  it("THE RUN-NEW-AUDIT BUTTON IS LIVE, because phase (f) built the flow it names", () => {
    // INVERTED IN SESSION 71, and this is the assertion doing the job it was
    // written for. Session 70 shipped a sentence instead of a button under 329's
    // rule that a control which cannot yet do the right thing must do nothing,
    // and pinned the absence so the button could not appear before its route
    // did. Both halves now hold: the control exists, and so does /audit/connect.
    expect(historySource).toContain("/audit/connect");
    expect(historySource).toContain("Run new audit");
    expect(historySource).toContain("Run first audit");
    expect(runSource).toContain("/audit/connect");
    // The sentence it replaced is gone rather than left beside its own button.
    expect(historySource).not.toContain("Running one on demand is not built yet");
    // DERIVED: the destination is a real route, so this cannot go green against
    // a button that 404s. That is the direction the old plant was protecting.
    const routes = readFileSync(
      fileURLToPath(new URL("../app/routes.ts", import.meta.url)),
      "utf8",
    );
    expect(routes).toContain('route("audit/connect", "./routes/audit/connect.tsx")');
  });

  it("no copy-link affordance, because legacy's link is not shareable", () => {
    // Legacy's own stored-run page redirects a signed-out visitor and filters
    // account_id, so its Copy link produces a URL only the same account can
    // open. The button is not ported rather than ported and quietly useless.
    expect(runSource).not.toContain("Copy link");
    expect(runSource).not.toContain("clipboard");
  });

  it("neither surface writes anything, and neither bills", () => {
    for (const [name, code] of [
      ["run", runSource],
      ["history", historySource],
    ] as const) {
      for (const forbidden of [
        "recordOutcome",
        "executeMoneyWrite",
        "billingLineItems",
        "db.insert",
        "db.update",
      ]) {
        expect(code, `${forbidden} reached the ${name} surface`).not.toContain(forbidden);
      }
    }
  });

  it("renders SIX decline categories, derived, not legacy's four", () => {
    expect(sectionsSource).toContain("DECLINE_CATEGORY_LABELS");
    expect(sectionsSource).not.toContain('label="Soft declines"');
  });

  it("the unread sentence is one string, used rather than retyped", () => {
    expect(SCOPE_UNREAD).toBe("Could not be read on this run.");
    expect(sectionsSource).toContain("SCOPE_UNREAD");
    expect(SCOPE_UNREAD).not.toContain(String.fromCharCode(0x2014));
  });

  it("AND THERE IS EXACTLY ONE COPY OF THE SECTIONS, so the null cannot drift", () => {
    // The reason the two assertions above could safely move to one file. If a
    // surface ever inlines its own copy of a section instead of importing this
    // one, the `?? 0` defect 365 binding 2 named gets a second place to live and
    // only one of the two would be re-read. Derived: every route that renders a
    // run must import from the shared module.
    for (const [name, code] of [
      ["stored run", runSource],
      ["live results", source("app/routes/audit/results.tsx")],
    ] as const) {
      expect(code, `${name} does not import the shared sections`).toContain(
        'from "~/components/audit/sections"',
      );
      expect(code, `${name} re-implements a section`).not.toContain("function AuditRecoverySection");
    }
  });
});
