
import { describe, expect, it, vi } from "vitest";

import { sentryOptions } from "~/lib/errors/sentry-options";

// SESSION 78, RULING 371 BINDING 6: the latent peer conflict is fixed, and this
// suite is the half that proves the FIX CHANGED NOTHING AT RUNTIME.
//
// WHY A PLANT AT ALL FOR A VERSION BUMP. `@sentry/cloudflare` is wired into the
// worker entry and wraps every request, every queue batch and every cron run.
// It is also a no-op today, because `SENTRY_DSN` is unset in production
// (core.md launch blocker 8) and the options callback returns undefined without
// it. A dependency that is inert is exactly the kind that can start doing
// something on a bump without anyone noticing, since nothing observable changes
// until the day the DSN is set and the behaviour is suddenly two versions away
// from what was reviewed.
//
// SO THE PROPERTY PINNED HERE IS THE INERTNESS ITSELF: with no DSN, the options
// callback returns undefined, the SDK initialises nothing, and no network call
// is attempted. Asserted against the REAL package rather than a description of
// it.



describe("PLANT 2: the SDK is still inert without a DSN", () => {
  it("the options callback returns undefined when SENTRY_DSN is unset", async () => {
    // UPDATED DELIBERATELY IN J05 (job_f1f5ebd7fe50). This plant used to copy
    // the inline expression `{ dsn, tracesSampleRate: 1 }` from the worker
    // entry. J05 moved the options into sentryOptions() with sendDefaultPii
    // false, a 0.1 trace rate and a scrubber, so the plant now calls the real
    // function instead of a copy. The property it guards is unchanged: an env
    // with no DSN yields undefined, which tells the SDK not to initialise.
    // test/sentry-posture-j05.test.ts pins the posture itself.
    expect(sentryOptions({})).toBeUndefined();
    expect(sentryOptions({ SENTRY_DSN: "" })).toBeUndefined();
    // And the positive control, so the assertion above is the DSN check and not
    // a function that returns undefined for everything.
    expect(sentryOptions({ SENTRY_DSN: "https://k@o.ingest.test/1" })).toMatchObject({
      dsn: "https://k@o.ingest.test/1",
      sendDefaultPii: false,
      tracesSampleRate: 0.1,
    });
  });

  it("withSentry RETURNS THE HANDLER OBJECT and does not touch the network at wrap time", async () => {
    // THE BEHAVIOURAL LIMIT, STATED RATHER THAN FAKED. Driving the wrapped
    // fetch() end to end needs a real Workers runtime: the wrapper reaches for
    // AsyncLocalStorage and the execution context, and under plain vitest the
    // call hangs rather than returning. That is the harness, not the product,
    // and a test that timed out was not allowed to stand in for a proof.
    //
    // What IS checkable here: wrapping is inert. Constructing the handler with
    // no DSN performs no network call and yields an object carrying the same
    // entry points, which is the part a version bump could plausibly break.
    const { withSentry } = await import("@sentry/cloudflare");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const handler = { async fetch() { return new Response("ok"); } };
    const wrapped = withSentry<{ SENTRY_DSN?: string }>(
      sentryOptions,
      handler,
    );

    expect(typeof wrapped.fetch).toBe("function");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("and captureException with no DSN does not throw into the caller", async () => {
    // Seven call sites depend on this. Every one of them is inside a path that
    // must not fail because telemetry did: webhook processing, outcome
    // recording, dispute detail.
    const Sentry = await import("@sentry/cloudflare");
    expect(() => Sentry.captureException(new Error("inert"))).not.toThrow();
  });
});
