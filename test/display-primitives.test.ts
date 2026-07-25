import { describe, expect, it } from "vitest";

import { formatDateShort, formatRelativeFuture, formatTimestamp } from "~/lib/date-format";
import {
  recoveryRateBand,
  recoveryRateClassNameOrNull,
} from "~/lib/dashboard/recovery-rate";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";

describe("formatMoneyShort", () => {
  it("drops the cents that formatMoney keeps", () => {
    expect(formatMoney(1_234_000, "usd")).toBe("$12,340.00");
    expect(formatMoneyShort(1_234_000, "usd")).toBe("$12,340");
  });

  it("rounds rather than truncating", () => {
    expect(formatMoneyShort(1060, "usd")).toBe("$11");
    expect(formatMoneyShort(1040, "usd")).toBe("$10");
  });

  it("honors the currency, like formatMoney", () => {
    expect(formatMoneyShort(500_00, "eur")).toBe("€500");
  });
});

describe("formatDateShort", () => {
  it("renders a short month-day-year date", () => {
    expect(formatDateShort(new Date("2026-03-04T12:00:00Z"))).toBe("Mar 4, 2026");
  });

  it("returns an empty string for null so callers need no branch", () => {
    expect(formatDateShort(null)).toBe("");
  });

  // A UTC-pinned formatter is the whole point: an unpinned one renders a
  // different day on a client east or west of the server and trips hydration.
  it("pins UTC, so a late-UTC instant does not roll to the local day", () => {
    expect(formatDateShort(new Date("2026-03-04T23:59:00Z"))).toBe("Mar 4, 2026");
    expect(formatDateShort(new Date("2026-03-04T00:01:00Z"))).toBe("Mar 4, 2026");
  });
});

describe("formatTimestamp", () => {
  it("renders date and time together", () => {
    expect(formatTimestamp(new Date("2026-03-04T15:04:00Z"))).toBe("Mar 4, 2026, 3:04 PM");
  });

  it("returns an empty string for null", () => {
    expect(formatTimestamp(null)).toBe("");
  });
});

describe("formatRelativeFuture", () => {
  const now = Date.parse("2026-03-04T12:00:00Z");
  const at = (iso: string) => formatRelativeFuture(new Date(iso), now);

  it("says due now once the moment has passed", () => {
    expect(at("2026-03-04T12:00:00Z")).toBe("due now");
    expect(at("2026-03-04T11:59:00Z")).toBe("due now");
  });

  it("renders sub-hour distances in minutes", () => {
    expect(at("2026-03-04T12:45:00Z")).toBe("in 45m");
    expect(at("2026-03-04T12:00:30Z")).toBe("in 1m");
  });

  // The recovery queue's job is telling a merchant how soon the next step
  // fires; "in 3h" would hide up to 59 minutes of that.
  it("carries minutes in the hour form", () => {
    expect(at("2026-03-04T15:20:00Z")).toBe("in 3h 20m");
    expect(at("2026-03-04T15:00:00Z")).toBe("in 3h");
  });

  it("carries a 60-minute rounding up into the hour instead of printing 60m", () => {
    expect(at("2026-03-04T15:59:40Z")).toBe("in 4h");
  });

  it("drops hours at day distance", () => {
    expect(at("2026-03-06T18:00:00Z")).toBe("in 2d");
  });

  it("returns null for null so a caller can omit the element", () => {
    expect(formatRelativeFuture(null, now)).toBeNull();
  });
});

describe("recoveryRateBand", () => {
  // Thresholds are DESIGN.md canon: 0-20 red, 21-35 amber, 36+ green.
  it("names the band at and around each boundary", () => {
    expect(recoveryRateBand(0)).toBe("Below target");
    expect(recoveryRateBand(20)).toBe("Below target");
    expect(recoveryRateBand(21)).toBe("Near target");
    expect(recoveryRateBand(35)).toBe("Near target");
    expect(recoveryRateBand(36)).toBe("Above target");
    expect(recoveryRateBand(100)).toBe("Above target");
  });

  // No failures is not the same as a 0% rate: nothing has failed, so there is
  // no rate to judge and "Below target" would be a false accusation.
  it("distinguishes no-history from a genuine zero", () => {
    expect(recoveryRateBand(null)).toBe("No failures yet");
    expect(recoveryRateBand(null)).not.toBe(recoveryRateBand(0));
  });
});

describe("recoveryRateClassNameOrNull", () => {
  it("renders a no-history account subtle rather than alarming red", () => {
    expect(recoveryRateClassNameOrNull(null)).toBe("text-text-subtle");
    expect(recoveryRateClassNameOrNull(0)).toBe("text-error-text");
  });

  it("matches the non-null helper for real rates", () => {
    expect(recoveryRateClassNameOrNull(50)).toBe("text-success-text");
    expect(recoveryRateClassNameOrNull(25)).toBe("text-amber-text");
  });
});
