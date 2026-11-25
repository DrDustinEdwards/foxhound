import { describe, expect, it } from "vitest";

import { shouldSuppress, type EmailServiceEvent } from "~/lib/email/events";

describe("bounce/complaint suppression", () => {
  const evt = (type: string, email = "a@b.com"): EmailServiceEvent => ({
    type,
    email,
    eventId: "ev_1",
  });

  it("suppresses hard bounces and complaints, ignores delivered/opened", () => {
    expect(shouldSuppress(evt("bounce"))).toBe(true);
    expect(shouldSuppress(evt("complaint"))).toBe(true);
    expect(shouldSuppress(evt("delivered"))).toBe(false);
    expect(shouldSuppress(evt("bounce", ""))).toBe(false); // no address
  });
});
