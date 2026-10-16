import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import * as constants from "~/lib/constants";
import { DECLINE_CATEGORIES } from "~/lib/constants";
import { isRetryStep, RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import {
  SEQUENCE_CATEGORY_DESCRIPTIONS,
  SEQUENCE_CATEGORY_NAMES,
  SEQUENCE_CATEGORY_ORDER,
  sequenceRateClassName,
  sequenceRateTone,
} from "~/lib/recovery/sequence-categories";
import {
  buildCategorySections,
  buildStepCard,
  formatStepTiming,
  sequenceStepLabel,
  summarizeStepPerformance,
  type StepPerformanceInput,
} from "~/lib/recovery/sequence-performance";
import RecoverySequences from "~/routes/app/recovery/sequences";

// J12 (job_d1f3a5e9c2f6), row S9: /recovery/sequence is Recova's page
// (app/(app)/recovery/sequence/page.tsx 953c3f57, components/SequenceView.tsx
// 5507b89f, StepPerformanceChart.tsx edf8f83c, lib/sequence-utils.ts 061aba7a,
// each read whole) on Capsomer 0.9.0's parts, its chart drawn by Enarratio
// 0.3.1, teal throughout, on Foxhound's six categories and silent-retry-first
// schedules (ruling 80). Every assertion here was seen failing first.

// ---- Recova's words, on Foxhound's engine ----

describe("J12: Recova's category names and order", () => {
  it("names each category as Recova does, plural", () => {
    expect(SEQUENCE_CATEGORY_NAMES.soft).toBe("Soft declines");
    expect(SEQUENCE_CATEGORY_NAMES.expired).toBe("Expired cards");
    expect(SEQUENCE_CATEGORY_NAMES.network).toBe("Network errors");
    expect(SEQUENCE_CATEGORY_NAMES.fraud).toBe("Fraud flags");
    // Foxhound's two extra categories follow the same plural pattern.
    expect(SEQUENCE_CATEGORY_NAMES.revoked).toBe("Revoked authorizations");
    expect(SEQUENCE_CATEGORY_NAMES.unknown).toBe("Unclassified declines");
  });

  it("orders Recova's four first, as Recova does, then Foxhound's two", () => {
    expect(SEQUENCE_CATEGORY_ORDER).toEqual(["soft", "expired", "network", "fraud", "revoked", "unknown"]);
    expect([...SEQUENCE_CATEGORY_ORDER].sort()).toEqual([...DECLINE_CATEGORIES].sort());
  });
});

describe("J12: Recova's step names, from Foxhound's schedules", () => {
  it("names an email step as Recova does", () => {
    expect(sequenceStepLabel("email_day1", 1)).toBe("Day 1 email");
    expect(sequenceStepLabel("email_day3", 72)).toBe("Day 3 email");
    expect(sequenceStepLabel("email_day7", 168)).toBe("Day 7 email");
    expect(sequenceStepLabel("email_day14", 336)).toBe("Day 14 email");
    expect(sequenceStepLabel("email_day30", 720)).toBe("Day 30 email");
  });

  it("names a retry by its own category's offset, so a 24 hour retry never reads 48hr", () => {
    expect(sequenceStepLabel("retry_4hr", constants.STEP_TIMING_RETRY_4HR_HOURS)).toBe("4hr retry");
    expect(sequenceStepLabel("retry_early", constants.STEP_TIMING_RETRY_EARLY_HOURS)).toBe("4hr retry");
    expect(sequenceStepLabel("retry_day2", constants.STEP_TIMING_RETRY_DAY2_HOURS)).toBe("48hr retry");
    expect(sequenceStepLabel("retry_day2", constants.STEP_TIMING_NETWORK_RETRY_DAY2_HOURS)).toBe("24hr retry");
    expect(sequenceStepLabel("retry_day21", constants.STEP_TIMING_RETRY_DAY21_HOURS)).toBe("Day 21 retry");
  });

  it("names the revoked category's one email", () => {
    expect(sequenceStepLabel("email_revoked", constants.STEP_TIMING_REVOKED_EMAIL_HOURS)).toBe("Revocation email");
  });

  it("gives the step cards and the chart these names", () => {
    const sections = buildCategorySections(SEQUENCE_CATEGORY_ORDER, []);
    const soft = sections.find((s) => s.category === "soft")!;
    expect(soft.stepCards.map((c) => c.label)).toEqual([
      "4hr retry",
      "Day 1 email",
      "48hr retry",
      "Day 3 email",
      "Day 7 email",
      "Day 14 email",
      "Day 21 retry",
      "Day 30 email",
    ]);
    const network = sections.find((s) => s.category === "network")!;
    expect(network.stepCards[1]!.label).toBe("24hr retry");
    const chart = summarizeStepPerformance([step({ stepType: "email_day3" })]).chart;
    expect(chart.map((c) => c.label)).toEqual(["Day 3 email"]);
  });
});

describe("J12: Recova's timing chip says hours", () => {
  it("writes every offset in hours, as Recova's chips do", () => {
    expect(formatStepTiming(1)).toBe("1 hour after failure");
    expect(formatStepTiming(4)).toBe("4 hours after failure");
    expect(formatStepTiming(72)).toBe("72 hours after failure");
    expect(formatStepTiming(168)).toBe("168 hours after failure");
    expect(formatStepTiming(720)).toBe("720 hours after failure");
  });
});

describe("J12: Recova's rate colours", () => {
  it("bands open rate above 50 green, 20 to 50 caution, under 20 red", () => {
    expect(sequenceRateTone(51, "open")).toBe("green");
    expect(sequenceRateTone(50, "open")).toBe("caution");
    expect(sequenceRateTone(20, "open")).toBe("caution");
    expect(sequenceRateTone(19, "open")).toBe("red");
  });

  it("bands click rate above 20 green, 5 to 20 caution, under 5 red", () => {
    expect(sequenceRateTone(21, "click")).toBe("green");
    expect(sequenceRateTone(20, "click")).toBe("caution");
    expect(sequenceRateTone(5, "click")).toBe("caution");
    expect(sequenceRateTone(4, "click")).toBe("red");
  });

  it("draws the middle band in caution, never an amber", () => {
    expect(sequenceRateClassName(30, "open")).toBe("text-caution");
    expect(sequenceRateClassName(80, "open")).toBe("text-success-text");
    expect(sequenceRateClassName(0, "click")).toBe("text-error-text");
  });
});

describe("J12: the latest subject is Recova's pick", () => {
  it("shows the newest send that has a subject, with that send's body", () => {
    const card = buildStepCard(
      "email_day1",
      [
        { executedAt: new Date("2026-10-03"), result: "email_sent", openedAt: null, clickedAt: null, aiSubject: null, aiBodyHtml: null },
        { executedAt: new Date("2026-10-02"), result: "email_sent", openedAt: null, clickedAt: null, aiSubject: "Older subject", aiBodyHtml: "<p>Older body</p>" },
      ],
      1,
    );
    if (card.kind !== "email") throw new Error("expected an email card");
    expect(card.latestSubject).toBe("Older subject");
    expect(card.latestBodyHtml).toBe("<p>Older body</p>");
  });
});

// ---- Every sentence on the page is true against the engine ----

describe("J12: the category descriptions are true against RECOVERY_SCHEDULES", () => {
  const leadsWithRetry = (c: keyof typeof RECOVERY_SCHEDULES) => isRetryStep(RECOVERY_SCHEDULES[c][0]!.stepType);
  const hasRetry = (c: keyof typeof RECOVERY_SCHEDULES) => RECOVERY_SCHEDULES[c].some((s) => isRetryStep(s.stepType));

  it("follows Recova's sentences, with Foxhound's name", () => {
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.expired).toBe(
      "Expired card declines. Foxhound sends emails only. Retrying an expired card never succeeds.",
    );
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.network).toBe(
      "Processing errors and issuer timeouts. Foxhound retries first, then emails if retries fail.",
    );
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.fraud).toBe(
      "Fraud flags and security holds. Foxhound sends reassurance emails. Retries are not attempted.",
    );
  });

  it("states the soft retry's hours from the soft schedule", () => {
    const retry = RECOVERY_SCHEDULES.soft.find((s) => s.stepType === "retry_day2")!;
    expect(leadsWithRetry("soft")).toBe(true);
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.soft).toBe(
      `Insufficient funds and generic declines. Foxhound retries silently first, then sends an email and retries the payment again ${retry.offsetHours} hours after the failure.`,
    );
  });

  it("says emails only, or no retries, only where the schedule has no retry", () => {
    for (const c of DECLINE_CATEGORIES) {
      const text = SEQUENCE_CATEGORY_DESCRIPTIONS[c];
      if (/emails only|not attempted|never succeeds/.test(text)) expect(hasRetry(c), c).toBe(false);
      if (/retries first|retries silently first/.test(text)) expect(leadsWithRetry(c), c).toBe(true);
    }
    expect(RECOVERY_SCHEDULES.unknown).toEqual(RECOVERY_SCHEDULES.expired);
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.unknown).toContain("same schedule as an expired card");
    expect(RECOVERY_SCHEDULES.revoked).toHaveLength(1);
    expect(SEQUENCE_CATEGORY_DESCRIPTIONS.revoked).toContain("one email");
  });
});

// ---- The page ----

function step(overrides: Partial<StepPerformanceInput> = {}): StepPerformanceInput {
  return { stepType: "email_day1", result: "email_sent", openedAt: null, clickedAt: null, creditedRecovery: false, ...overrides };
}

type LoaderData = Awaited<ReturnType<typeof import("~/routes/app/recovery/sequences").loader>>;
const Page = RecoverySequences as unknown as (props: { loaderData: LoaderData }) => ReactElement;

function makeLoaderData(sent: boolean): LoaderData {
  const opened = new Date("2026-10-02T10:00:00Z");
  const rows = sent
    ? [
        { declineCategory: "soft" as const, stepType: "email_day1", executedAt: new Date("2026-10-02T09:00:00Z"), result: "email_sent", openedAt: opened, clickedAt: opened, aiSubject: "Your payment did not go through", aiBodyHtml: "<p>Hello</p>", creditedRecovery: true },
        { declineCategory: "soft" as const, stepType: "email_day1", executedAt: new Date("2026-10-03T09:00:00Z"), result: "email_sent", openedAt: opened, clickedAt: null, aiSubject: "Your payment did not go through", aiBodyHtml: "<p>Hello</p>", creditedRecovery: false },
        { declineCategory: "soft" as const, stepType: "email_day1", executedAt: new Date("2026-10-04T09:00:00Z"), result: "email_sent", openedAt: null, clickedAt: null, aiSubject: "Your payment did not go through", aiBodyHtml: "<p>Hello</p>", creditedRecovery: false },
        { declineCategory: "soft" as const, stepType: "retry_early", executedAt: new Date("2026-10-01T13:00:00Z"), result: "retry_succeeded", openedAt: null, clickedAt: null, aiSubject: null, aiBodyHtml: null, creditedRecovery: true },
      ]
    : [];
  return {
    performance: summarizeStepPerformance(rows),
    sections: buildCategorySections(SEQUENCE_CATEGORY_ORDER, rows),
  } as LoaderData;
}

function render(data: LoaderData): string {
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page, { loaderData: data })));
  } catch (err) {
    return `render failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function headings(html: string): Array<[number, string]> {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => [
    Number(m[1]),
    m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  ]);
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

const SOURCE = readFileSync(new URL("../app/routes/app/recovery/sequences.tsx", import.meta.url), "utf8");

describe("J12: the page head", () => {
  it("is titled Recovery sequence, with Recova's lead", () => {
    const html = render(makeLoaderData(true));
    expect(headings(html)[0]).toEqual([1, "Recovery sequence"]);
    expect(textOf(html)).toContain("Live performance data from your recovery emails");
  });
});

describe("J12: headings keep every level (RULES.md 1.5)", () => {
  it("puts Step performance and each category under h2, each step under h3", () => {
    const hs = headings(render(makeLoaderData(true)));
    expect(hs).toContainEqual([2, "Step performance"]);
    for (const c of SEQUENCE_CATEGORY_ORDER) expect(hs).toContainEqual([2, SEQUENCE_CATEGORY_NAMES[c]]);
    const steps = hs.filter(([level]) => level === 3).map(([, t]) => t);
    expect(steps.some((t) => t.startsWith("Day 1 email"))).toBe(true);
    expect(steps.some((t) => t.startsWith("4hr retry"))).toBe(true);
    // Never a level skipped: an h3 always follows an h2.
    const levels = hs.map(([l]) => l);
    for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
  });

  it("shows the categories in Recova's order", () => {
    const names = headings(render(makeLoaderData(false)))
      .filter(([l]) => l === 2)
      .map(([, t]) => t)
      .filter((t) => t !== "Step performance");
    expect(names).toEqual(SEQUENCE_CATEGORY_ORDER.map((c) => SEQUENCE_CATEGORY_NAMES[c]));
  });
});

describe("J12: the empty state is Recova's", () => {
  it("says No emails sent yet, then Recova's sentence, on Capsomer's empty state", () => {
    const html = render(makeLoaderData(false));
    expect(html).toContain("cap-empty");
    expect(textOf(html)).toContain("No emails sent yet");
    expect(textOf(html)).toContain("Recovery sequences start automatically when a payment fails.");
  });

  it("draws the chart card without its caveat when there is nothing to plot", () => {
    const text = textOf(render(makeLoaderData(false)));
    expect(text).toContain("No step performance to show yet.");
    expect(text).not.toContain("even without clicking the tracked link");
  });
});

describe("J12: Capsomer parts and an Enarratio chart", () => {
  it("draws the stat cards, chart card and step cards as Capsomer panels", () => {
    const html = render(makeLoaderData(true));
    expect(html).toContain("cap-page-head");
    expect((html.match(/class="cap-panel/g) ?? []).length).toBeGreaterThan(10);
    expect(html).toContain("cap-pill");
    expect(html).toContain("cap-disclosure");
  });

  it("draws step performance with Enarratio: grouped bars, Recova's three series in funnel order, a text equivalent", () => {
    const html = render(makeLoaderData(true));
    expect(html).toContain('data-enarratio="bar"');
    const legend = [...html.matchAll(/data-enarratio-series="([^"]+)" data-slot/g)].map((m) => m[1]);
    expect(legend).toEqual(["Open rate", "Click rate", "Recovery rate"]);
    expect(html).toMatch(/role="img" aria-label="[^"]*Day 1 email[^"]*67% opened/);
  });

  it("imports nothing from the hand-built charts and no Foxhound StatCard or Badge", () => {
    expect(SOURCE).not.toContain("~/components/charts");
    expect(SOURCE).not.toContain("~/components/stat-card");
    expect(SOURCE).not.toContain("~/components/badge");
  });

  it("carries no amber and only the five text sizes", () => {
    expect(SOURCE).not.toMatch(/amber/i);
    expect(SOURCE).not.toMatch(/text-\[/);
    expect(SOURCE).not.toMatch(/\btext-(xs|sm|base|lg|xl|2xl|3xl)\b/);
  });

  it("draws Recova's recovery-rate series in teal, not its amber", () => {
    expect(SOURCE).toMatch(/"Recovery rate": "var\(--brand-ui\)"/);
  });
});

describe("J12: contrast on the dark raised header", () => {
  it("keeps each step's figures and subtle text out of the panel's raised header", () => {
    const html = render(makeLoaderData(true));
    const heads = [...html.matchAll(/<header class="cap-panel-head">([\s\S]*?)<\/header>/g)].map((m) => m[1]!);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head).not.toMatch(/text-(error-text|caution|success-text|text-subtle)/);
      expect(head).not.toContain("recovered");
    }
  });
});

describe("J12: the stat row is Recova's", () => {
  it("colours the averages by Recova's bands", () => {
    const html = render(makeLoaderData(true));
    // 3 sent, 2 opened (67%, green), 1 clicked (33%, green).
    expect(html).toMatch(/text-success-text[^"]*">67%</);
    expect(html).toMatch(/text-success-text[^"]*">33%</);
  });

  it("writes the sent count with thousands separators", () => {
    const many = Array.from({ length: 1234 }, () => step());
    expect(textOf(render({ ...makeLoaderData(true), performance: summarizeStepPerformance(many) } as LoaderData))).toContain("1,234");
  });
});
