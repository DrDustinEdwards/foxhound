import { describe, expect, it } from "vitest";

import {
  breachesThreshold,
  evaluateAlerts,
  type AlertConfig,
} from "~/lib/intelligence/alerts";

describe("breachesThreshold", () => {
  it("breaches 'above' when actual exceeds threshold", () => {
    expect(breachesThreshold("above", 51, 50)).toBe(true);
    expect(breachesThreshold("above", 50, 50)).toBe(false);
    expect(breachesThreshold("above", 49, 50)).toBe(false);
  });

  it("breaches 'below' when actual is under threshold", () => {
    expect(breachesThreshold("below", 39, 40)).toBe(true);
    expect(breachesThreshold("below", 40, 40)).toBe(false);
    expect(breachesThreshold("below", 41, 40)).toBe(false);
  });
});

describe("evaluateAlerts", () => {
  const NOW = Date.UTC(2026, 9, 16, 3);
  const configs: AlertConfig[] = [
    {
      id: "alert_1",
      accountId: "acct_1",
      metric: "health_score_avg",
      thresholdValue: 40,
      direction: "below",
      channel: "email",
      lastTriggeredAt: null,
    },
    {
      id: "alert_2",
      accountId: "acct_1",
      metric: "mrr_at_risk_cents",
      thresholdValue: 100_000,
      direction: "above",
      channel: "email",
      lastTriggeredAt: null,
    },
  ];

  it("fires only the alerts whose metric breaches", () => {
    const firings = evaluateAlerts(configs, { health_score_avg: 35, mrr_at_risk_cents: 50_000 }, NOW);
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ alertId: "alert_1", actualValue: 35 });
  });

  it("skips an alert whose metric has no computed value this run", () => {
    expect(evaluateAlerts([configs[0]], {}, NOW)).toEqual([]);
  });

  it("does not re-fire inside the 24h cooldown, and does once it has passed (Recova's rule)", () => {
    const fired = (hoursAgo: number) =>
      evaluateAlerts(
        [{ ...configs[0], lastTriggeredAt: new Date(NOW - hoursAgo * 3_600_000) }],
        { health_score_avg: 20 },
        NOW,
      );
    expect(fired(22)).toEqual([]);
    // Within the hour's margin for a nightly run that starts a little early.
    expect(fired(23.5)).toHaveLength(1);
    expect(fired(24)).toHaveLength(1);
  });
});
