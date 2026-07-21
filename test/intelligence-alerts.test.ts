import { describe, expect, it } from "vitest";

import {
  breachesThreshold,
  evaluateAlerts,
  shouldFireAlert,
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

describe("shouldFireAlert (edge-triggered)", () => {
  const alert = { direction: "below", thresholdValue: 40 };

  it("fires on a first-ever breach (no prior evaluation)", () => {
    expect(shouldFireAlert(alert, null, 30)).toBe(true);
  });

  it("does not fire when not breaching", () => {
    expect(shouldFireAlert(alert, null, 50)).toBe(false);
  });

  it("does not re-fire while continuously breaching", () => {
    expect(shouldFireAlert(alert, 35, 30)).toBe(false);
  });

  it("fires again after clearing and re-breaching", () => {
    expect(shouldFireAlert(alert, 50, 30)).toBe(true);
  });
});

describe("evaluateAlerts", () => {
  const configs: AlertConfig[] = [
    {
      id: "alert_1",
      accountId: "acct_1",
      metric: "health_score_avg",
      thresholdValue: 40,
      direction: "below",
      channel: "email",
    },
    {
      id: "alert_2",
      accountId: "acct_1",
      metric: "mrr_at_risk_cents",
      thresholdValue: 100_000,
      direction: "above",
      channel: "email",
    },
  ];

  it("fires only the alerts whose metric breaches and were not already breaching", () => {
    const firings = evaluateAlerts(
      configs,
      { health_score_avg: 35, mrr_at_risk_cents: 50_000 },
      new Map([
        ["alert_1", null],
        ["alert_2", null],
      ]),
    );
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ alertId: "alert_1", actualValue: 35 });
  });

  it("skips an alert whose metric has no computed value this run", () => {
    const firings = evaluateAlerts(
      [configs[0]],
      {},
      new Map([["alert_1", null]]),
    );
    expect(firings).toEqual([]);
  });

  it("does not re-fire an alert that was already breaching last run", () => {
    const firings = evaluateAlerts(
      [configs[0]],
      { health_score_avg: 20 },
      new Map([["alert_1", 25]]),
    );
    expect(firings).toEqual([]);
  });
});
