import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it, vi } from "vitest";


import { createInMemoryDb } from "./helpers/inmemory-db";

// J35, row S30, under Dustin's Q10 and Q11 rulings of
// 2026-10-14: /settings/audit is Recova's page (app/(app)/settings/audit/page.tsx
// at blob 18e6a384, AuditForm.tsx at 5bf81c10, settings/components/AuditSection.tsx
// at 58c5abce, components/Toggle.tsx at 0ebdd395, and settings/SaveBar.tsx at
// f1d6eb23) built from Capsomer 0.9.0's components, amber throughout. Recova stays
// the spec for every section, label and control and their order; the page keeps
// the settings layout's 800px column.
//
// The NULL-is-off reads, the server clamp and the no-DEFAULT guard stay in
// settings-audit-315.test.ts; the lookback's reader is proven in
// audit-lookback-reader-j35.test.ts.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/audit");


const Page = route.default as unknown as (props: {
  loaderData: { lookbackDays: number; autoRun: boolean };
  actionData?: Record<string, unknown>;
}) => ReactElement;

function render(
  opts: { lookbackDays?: number; autoRun?: boolean; actionData?: Record<string, unknown> } = {},
): string {
  const loaderData = { lookbackDays: opts.lookbackDays ?? 90, autoRun: opts.autoRun ?? false };
  const Stub = createRoutesStub([
    {
      path: "/settings/audit",
      Component: () => createElement(Page, { loaderData, actionData: opts.actionData }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/settings/audit"] }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("J35 review: a write that throws reaches the merchant and the log", () => {
  it("the real action catches it, logs the Error, answers 500 and the page says Recova's failure line", async () => {
    const { db } = createInMemoryDb();
    const boom = new Error("D1_ERROR: database is locked");
    harness.db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") return async () => { throw boom; };
        return Reflect.get(target, prop, receiver);
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = new FormData();
      body.append("audit_lookback_days", "60");
      body.append("audit_auto_run", "true");
      const ctx = {
        get: (key: unknown) => {
          const name = String((key as { name?: string })?.name ?? "");
          if (name.includes("cloudflare")) return { env: {} as Env };
          return { membership: { accountId: "acct_j35" } };
        },
      } as never;
      const result = (await route.action({
        request: new Request("http://x/settings/audit", { method: "POST", body }),
        context: ctx,
      } as never)) as unknown as { data: Record<string, unknown>; init: { status?: number } };

      expect(logged).toHaveBeenCalledWith("audit settings write failed:", boom);
      expect(result.init?.status).toBe(500);
      expect(result.data.ok).toBe(false);

      const html = render({ actionData: result.data });
      expect(text(html)).toContain("Failed to save. Please try again.");
      expect(html).toMatch(/<span role="alert"[^>]*>Failed to save\. Please try again\.<\/span>/);
    } finally {
      logged.mockRestore();
    }
  });
});
