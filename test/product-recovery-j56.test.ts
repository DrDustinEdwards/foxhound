import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { isBillableRecoveryRow } from "~/lib/billing/billable-predicates";
import { recoveryFeeCents } from "~/lib/billing/fees";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  BILLABLE_ATTRIBUTION_KINDS,
  RECOVERY_FEE_BPS,
} from "~/lib/constants";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { buildTeamflowBase } from "~/lib/demo/customer-base";
import { buildRecoverySeed } from "~/lib/demo/recovery-seed";
import { formatMoney } from "~/lib/money-format";
import RecoveryProductPage, { loader } from "~/routes/products/recovery";

// J56 (job_95c1374a28ad), the Recovery spoke. Recova's spec, read whole at
// HEAD: app/(marketing)/product/recovery/page.tsx (blob ec4aded8),
// components/product/ProductSections.tsx (ba3aed7c), ProductFAQ.tsx (7c08a5a2),
// RecoveryDashboardPreview.tsx (565b772c) with its StatCards (b1923468) and
// ROIWidget (549b89ef), RecoveryPaymentsPreview.tsx (da19edf0) with its
// PaymentsTable (3dc398a2) and PaymentRow (0d2e1f52), CategoryPill.tsx
// (c7dc96f1) and SequenceTimeline.tsx (aa6a85fc).
//
// These read the RENDERED page, fed by the route's own loader, so a value
// that never reaches a reader cannot pass. Every expected number is worked
// out here a second way, straight from the demo seed and the engine
// constants, never read back from the module under test.

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    throw new Error("unexpected context key");
  },
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

async function load(): Promise<LoaderData> {
  return loader({
    context: fakeContext,
    request: new Request("https://foxhoundapp.com/product/recovery"),
    params: {},
  } as unknown as Parameters<typeof loader>[0]);
}

function render(loaderData: LoaderData): string {
  const Page = RecoveryProductPage as unknown as (props: { loaderData: LoaderData }) => React.ReactElement;
  const router = createMemoryRouter([{ path: "*", element: createElement(Page, { loaderData }) }], {
    initialEntries: ["/product/recovery"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Text with tags stripped and entities for the characters this page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The asOf instant the loader built its preview at, so this file rebuilds the same seed. */
function asOf(data: LoaderData): Date {
  const iso = (data as unknown as { preview?: { asOf?: string } }).preview?.asOf;
  expect(iso, "the loader names the instant its preview was built at").toBeTypeOf("string");
  return new Date(iso as string);
}




describe("the dashboard preview is the demo seed through Foxhound's own math (J56)", async () => {
  const data = await load();
  const html = render(data);
  const body = text(html);
  const demo = lazy(() => {
    const now = asOf(data);
    const seed = buildRecoverySeed(DEMO_ACCOUNT_ID, buildTeamflowBase(now), now);
    const failures = seed.failedPayments.filter((f) => !f.isRenewalNoise && !f.deletedAt);
    return { now, nowMs: now.getTime(), seed, failures, failureIds: new Set(failures.map((f) => f.id)) };
  });

  it("shows the ROI widget's two columns with Foxhound's fee on billable recoveries", () => {
    const { now, nowMs, seed } = demo();
    const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const billable = seed.recoveredPayments.filter((r) => isBillableRecoveryRow(r, nowMs));
    const all = billable.reduce((s, r) => s + r.amountCents, 0);
    // This month: every Foxhound-attributed recovery since the 1st, matured or
    // not, never refunded, disputed or deleted.
    const month = seed.recoveredPayments
      .filter(
        (r) =>
          (BILLABLE_ATTRIBUTION_KINDS as readonly string[]).includes(r.attributionKind ?? "") &&
          r.refundedAt == null &&
          r.disputedAt == null &&
          r.deletedAt == null &&
          r.recoveredAt.getTime() >= first,
      )
      .reduce((s, r) => s + r.amountCents, 0);
    expect(all, "the demo has billable recoveries to show").toBeGreaterThan(0);
    const pct = RECOVERY_FEE_BPS / 100;
    const m = (c: number) => escape(formatMoney(c, "usd"));
    expect(body).toMatch(
      new RegExp(
        `This month Recovered by Foxhound ${m(month)} Foxhound fee \\(${pct}%\\) ${m(recoveryFeeCents(month))} You kept ${m(month - recoveryFeeCents(month))}`,
      ),
    );
    expect(body).toMatch(
      new RegExp(
        `All time Total recovered by Foxhound ${m(all)} Total fees paid ${m(recoveryFeeCents(all))} Net to you ${m(all - recoveryFeeCents(all))}`,
      ),
    );
  });
});

function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
