import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import Help, { QUICK_ANSWERS } from "~/routes/app/help";
import { accounts, cronRunHistory } from "~/db";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import {
  CRON_LABELS,
  VISIBLE_CRONS,
  cronDisplayStatus,
  getVisibleCronStatus,
  type CronStatusRow,
} from "~/lib/help/platform-status.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Ruling 399, session 90 job 4. Row S23's owed work against legacy's REAL page,
// app/(app)/help/page.tsx, read whole:
//
//   container  max-w-[720px] mx-auto px-5 sm:px-8 py-10
//   header     PageHeader title "Help", subtitle
//              "Quick answers, guides, and platform status."
//   section 1  "Common questions", six QUICK_ANSWERS as h3 + p pairs
//   section 2  "Guides", PLATFORM_GUIDE full width then four PRODUCT_GUIDES in
//              a 2-col grid, each rounded-lg border p-4 hover:border-brand
//   section 3  "Platform status", a "Background jobs" card of four crons with a
//              time-ago and a status dot, then an "MCP connectors" card
//   section 4  "Contact", a bordered block with a mailto and the business-day
//              sentence
//
// FOUR OF THE 394 WALK'S S23 CLAIMS WERE FALSE and are deliberately not
// actioned: the H1 is "Help" on both sides, the container matches, the real
// page has no green reassurance banner, and there is no card-geometry
// divergence (ruling 399, correcting the walk's demo-twin baseline).
//
// FOUR THINGS ARE DELIBERATELY NOT LEGACY'S, each a truth about Foxhound:
//   * Q1 rewritten: ruling 80 made recovery silent-retry-first, so legacy's
//     "first email sends within an hour" is false here.
//   * Q6 rewritten: ruling 304 declines legacy's per-step body editor.
//   * "four scopes" becomes "six scopes": Foxhound's audit engine has six.
//   * ONE MCP connector, not legacy's two: workers/app.ts serves `/mcp` and no
//     `/mcp/admin` exists, so a second row would name a missing endpoint.
//
// And the fourth cron row is a substitution, asserted below so it is visible:
// legacy's fourth is process-disputes and Foxhound has no dispute cron at all.

const Page = Help as unknown as (props: {
  loaderData: { crons: CronStatusRow[]; nowMs: number };
}) => ReactElement;

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

const crons: CronStatusRow[] = [
  {
    cronName: "recovery-tick",
    label: "Recovery sequences",
    status: "ok",
    lastSucceededAt: new Date(NOW - 4 * 60_000),
  },
  {
    cronName: "winback-send",
    label: "Win-back sequences",
    status: "stale",
    lastSucceededAt: new Date(NOW - 5 * 3_600_000),
  },
  {
    cronName: "expiring-cards",
    label: "Expiring card alerts",
    status: "error",
    lastSucceededAt: new Date(NOW - 2 * 86_400_000),
  },
  {
    cronName: "intelligence-ai",
    label: "Customer health scoring",
    status: "pending",
    lastSucceededAt: null,
  },
];

function render(): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(Page, { loaderData: { crons, nowMs: NOW } }),
    ),
  );
}

describe("S23 /help: legacy's four sections", () => {
  it("renders all four section headings in legacy's order", () => {
    const html = render();
    const order = ["Common questions", "Guides", "Platform status", "Contact"].map((h) =>
      html.indexOf(h),
    );
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("carries legacy's page subtitle", () => {
    expect(render()).toContain("Quick answers, guides, and platform status.");
  });

  it("renders legacy's container width", () => {
    expect(render()).toContain("max-w-[720px]");
  });
});

describe("S23 /help: Common questions", () => {
  it("renders six question and answer pairs, legacy's count", () => {
    // The pre-port page had five differently-titled prose cards. Six is the
    // count ruling 399 measured on legacy's real page.
    expect(QUICK_ANSWERS).toHaveLength(6);
    const html = render();
    // Apostrophes come back as &#x27; from renderToStaticMarkup, so the
    // question is escaped the same way before it is looked for. Comparing the
    // raw string would fail on Q1 alone and pass on the other five, which reads
    // as a missing question rather than as an encoding artifact.
    for (const item of QUICK_ANSWERS) expect(html).toContain(item.q.replace(/'/g, "&#x27;"));
  });

  it("describes recovery as silent-retry-first, not email-first (ruling 80)", () => {
    const first = QUICK_ANSWERS[0].a;
    expect(first).toMatch(/retries the card quietly first/i);
    // Legacy's sentence, which is false of Foxhound and must not come back.
    expect(first).not.toMatch(/first email sends within an hour/i);
  });

  it("does not offer legacy's per-step body editor, which 304 declines", () => {
    const brandVoice = QUICK_ANSWERS[5].a;
    expect(brandVoice).toMatch(/Brand voice/);
    expect(brandVoice).not.toMatch(/edit the body directly/i);
  });

  it("keeps the recovery-rate bands, which ARE true of Foxhound", () => {
    // DESIGN.md: 0-20 red, 21-35 teal (brand), 36+ green. Ported unchanged, and pinned
    // so a later reader can see it was checked rather than copied.
    expect(QUICK_ANSWERS[2].a).toContain("21-35% is typical");
  });
});

describe("S23 /help: Guides", () => {
  it("links Platform plus the four product guides", () => {
    const html = render();
    for (const slug of ["platform", "audit", "recovery", "disputes", "intelligence"]) {
      expect(html).toContain(`href="/docs/${slug}"`);
    }
  });

  it("every guide it links is a real Foxhound doc route", () => {
    // The anti-drift check: /help must not link a slug /docs cannot serve.
    const html = render();
    const hrefs = [...html.matchAll(/href="\/docs\/([a-z-]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(5);
    for (const slug of hrefs) {
      expect(DOC_GUIDES.some((g) => g.slug === slug)).toBe(true);
    }
  });

  it("says six audit scopes, which is Foxhound's number", () => {
    const html = render();
    expect(html).toContain("six scopes");
    expect(html).not.toContain("four scopes");
  });
});

describe("S23 /help: Platform status", () => {
  it("renders a row per visible cron with a time-ago", () => {
    const html = render();
    expect(VISIBLE_CRONS).toHaveLength(4);
    for (const name of VISIBLE_CRONS) expect(html).toContain(CRON_LABELS[name]);
    expect(html).toContain("4m ago");
    expect(html).toContain("5h ago");
    expect(html).toContain("2d ago");
    expect(html).toContain("never");
  });

  it("gives each status its own dot colour", () => {
    const html = render();
    for (const cls of ["bg-green", "bg-brand", "bg-red", "bg-text-tertiary"]) {
      expect(html).toContain(cls);
    }
  });

  it("shows no dispute cron, because Foxhound has none", () => {
    // Legacy's fourth row is process-disputes. Foxhound takes dispute intake on
    // Stripe webhooks through the money DO, so there is no scheduled job here
    // and a "Dispute processing" row would name one that does not exist.
    expect(render()).not.toMatch(/dispute processing/i);
    expect([...VISIBLE_CRONS].some((n) => n.includes("dispute"))).toBe(false);
  });

  it("lists exactly one MCP connector, with 383's tool counts", () => {
    const html = render();
    expect(html).toContain("Foxhound Merchant");
    expect(html).toContain("foxhoundapp.com/mcp");
    expect(html).toContain("23 tools, 15 read and 8 write");
    // Legacy lists an admin connector too; Foxhound serves no /mcp/admin.
    expect(html).not.toMatch(/mcp\/admin/i);
  });
});

describe("S23 /help: Contact", () => {
  it("links the support address and keeps the business-day sentence", () => {
    const html = render();
    expect(html).toContain('href="mailto:support@foxhoundapp.com"');
    expect(html).toContain("Responses within 24 hours on business days.");
  });

  it("says nothing about whether that mailbox is routed yet", () => {
    // core.md blocker 7: apex Email Routing is not configured, so the address
    // currently bounces. The page links it and makes no claim either way; a
    // caveat on the page would be worse than the link, and a promise would be
    // false.
    const html = render();
    expect(html).not.toMatch(/not yet|bounce|coming soon|unavailable/i);
  });
});

describe("cronDisplayStatus", () => {
  it("reads a failed latest run as an error", () => {
    expect(cronDisplayStatus("failed", new Date(NOW - 60_000), NOW, "recovery-tick")).toBe("error");
  });

  it("reads no successful run ever as pending, not as an error", () => {
    expect(cronDisplayStatus(null, null, NOW, "recovery-tick")).toBe("pending");
  });

  it("reads a success older than the cron's own threshold as stale", () => {
    // recovery-tick allows 90 minutes; 91 is stale and 89 is not. Per-cron,
    // because expiring-cards is daily and 91 minutes is healthy for it.
    expect(cronDisplayStatus("success", new Date(NOW - 91 * 60_000), NOW, "recovery-tick")).toBe(
      "stale",
    );
    expect(cronDisplayStatus("success", new Date(NOW - 89 * 60_000), NOW, "recovery-tick")).toBe(
      "ok",
    );
    expect(cronDisplayStatus("success", new Date(NOW - 91 * 60_000), NOW, "expiring-cards")).toBe(
      "ok",
    );
  });

  it("does not read a skipped tick as a failure", () => {
    // `skipped` means disabled, not due or locked. Legacy has no such status;
    // treating it as an error would light the dot red the moment a cron is
    // paused rather than when it is actually behind.
    expect(cronDisplayStatus("skipped", new Date(NOW - 60_000), NOW, "recovery-tick")).toBe("ok");
  });
});

describe("getVisibleCronStatus", () => {
  async function seed(rows: { cronName: string; status: string; minutesAgo: number }[]) {
    const { db } = createInMemoryDb();
    const now = new Date(NOW);
    await db.insert(accounts).values({ id: "acc_1", name: "Acme", createdAt: now });
    let n = 0;
    for (const r of rows) {
      await db.insert(cronRunHistory).values({
        id: "crh_" + n++,
        cronName: r.cronName,
        finishedAt: new Date(NOW - r.minutesAgo * 60_000),
        status: r.status,
        createdAt: now,
      });
    }
    return db;
  }

  it("always returns four rows in the declared order, even with no history", async () => {
    const db = await seed([]);
    const rows = await getVisibleCronStatus(db, NOW);
    expect(rows.map((r) => r.cronName)).toEqual([...VISIBLE_CRONS]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("takes the newest SUCCESS for the time-ago and the newest run for the status", async () => {
    // The discriminating case: a cron that succeeded an hour ago and failed
    // five minutes ago must read as an error while still reporting the real
    // last success. Taking the newest row for both would lose the success time;
    // taking the newest success for both would hide the failure.
    const db = await seed([
      { cronName: "recovery-tick", status: "success", minutesAgo: 60 },
      { cronName: "recovery-tick", status: "failed", minutesAgo: 5 },
    ]);
    const row = (await getVisibleCronStatus(db, NOW)).find((r) => r.cronName === "recovery-tick")!;
    expect(row.status).toBe("error");
    expect(row.lastSucceededAt?.getTime()).toBe(NOW - 60 * 60_000);
  });

  it("ignores crons a merchant should not see", async () => {
    const db = await seed([{ cronName: "retention-ai-calls", status: "success", minutesAgo: 1 }]);
    const rows = await getVisibleCronStatus(db, NOW);
    expect(rows.map((r) => r.cronName)).not.toContain("retention-ai-calls");
  });
});
