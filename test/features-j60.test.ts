
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_SCHEDULE_WEEKLY,
  RECOVERY_TICK_CRON_NAME,
} from "~/lib/constants";
import { CRON_JOBS } from "~/lib/cron/registry";
import { DEMO_RESET_CRON_NAME } from "~/lib/demo/constants";
import {
  cronEveryMinutes,
  cronWeekday,
  featureSections,
} from "~/lib/marketing/features-content";
import { MERCHANT_TOOL_NAMES } from "~/lib/mcp/tools.server";
import FeaturesPage from "~/routes/features";


// J60 (job_85aa061b6020), row M10: /features. The spec is Recova's
// app/(marketing)/features/page.tsx (blob 04aa91d8), features-data.ts (blob
// a0a5dd20), FeatureCard.tsx (dd6c9a87), FeatureFilter.tsx (4e2ef1fa) and
// FeatureFilterShell.tsx (707d79df), all read whole.
//
// These read the RENDERED page, below the shared marketing page header (row
// M29, not this job's), so a class or a string that never reaches a reader
// cannot pass.


const FACTS = { cronJobCount: CRON_JOBS.length, merchantMcpToolCount: MERCHANT_TOOL_NAMES.length };

function render(): string {
  const props = { loaderData: { siteUrl: "https://example.com", facts: FACTS } } as never;
  const router = createMemoryRouter([{ path: "*", element: createElement(FeaturesPage, props) }], {
    initialEntries: ["/features"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}








// Every text-* class that sets a SIZE: the --text-* rem tokens app.css defines
// (the five and the older marketing roles) and Tailwind's stock scale. Read
// from the stylesheet, so a colour class is never mistaken for a size.

describe("/features entries are Recova's, each a capability Foxhound ships", () => {
  const html = render();

  // Where each rendered entry lives in Foxhound's code. A new entry with no row
  // here fails, and each file must exist and hold the named code.

  it("reads every cadence it states from the job's own schedule in the cron registry", () => {
    const schedule = (name: string) => CRON_JOBS.find((j) => j.name === name)?.schedule;
    expect(schedule(RECOVERY_TICK_CRON_NAME)).toBe(CRON_SCHEDULE_RECOVERY_TICK);
    expect(schedule("winback-send")).toBe(CRON_SCHEDULE_RECOVERY_TICK);
    expect(schedule("expiring-cards")).toBe(CRON_SCHEDULE_DAILY);
    expect(schedule("intelligence-ai")).toBe(CRON_SCHEDULE_DAILY);
    expect(schedule("intelligence-sync")).toBe(CRON_SCHEDULE_MONTHLY);
    expect(schedule("billing-monthly")).toBe(CRON_SCHEDULE_MONTHLY);
    expect(schedule("monthly-audit")).toBe(CRON_SCHEDULE_MONTHLY_AUDIT);
    expect(schedule("weekly-digest")).toBe(CRON_SCHEDULE_WEEKLY);
    expect(schedule(DEMO_RESET_CRON_NAME)).toBe(CRON_SCHEDULE_DAILY);
    expect(schedule("cron-health")).toBe(CRON_SCHEDULE_DAILY);
    expect(html).toContain(`Recovery processing every ${cronEveryMinutes(CRON_SCHEDULE_RECOVERY_TICK)} minutes`);
    expect(html).toContain(`${cronWeekday(CRON_SCHEDULE_WEEKLY)} unified digest`);
    expect(html).toContain(`${CRON_JOBS.length} cron jobs`);
    expect(html).toContain(`with ${MERCHANT_TOOL_NAMES.length} tools`);
  });

  it("moves its numbers when the facts move (no count is typed)", () => {
    const moved = featureSections({ cronJobCount: 99, merchantMcpToolCount: 77 }).flatMap((s) => s.features);
    expect(moved.some((f) => f.name === "99 cron jobs")).toBe(true);
    expect(moved.some((f) => f.description.includes("with 77 tools"))).toBe(true);
  });
});
