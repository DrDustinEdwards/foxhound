import { describe, expect, it } from "vitest";

import { shouldSuppress, type EmailServiceEvent } from "~/lib/email/events";

describe("bounce/complaint suppression", () => {
  const evt = (type: string, email = "a@b.com"): EmailServiceEvent => ({
    type,
    email,
    eventId: "ev_1",
    messageId: null,
    reason: null,
  });

  it("suppresses hard bounces and complaints, ignores delivered/opened", () => {
    expect(shouldSuppress(evt("hard_bounce"))).toBe(true);
    expect(shouldSuppress(evt("complaint"))).toBe(true);
    expect(shouldSuppress(evt("soft_bounce"))).toBe(false);
    expect(shouldSuppress(evt("delivered"))).toBe(false);
    expect(shouldSuppress(evt("hard_bounce", ""))).toBe(false); // no address
  });
});
