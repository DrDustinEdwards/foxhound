import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const PKG = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
};

describe("PLANT 1: the pin, and the reason for its exact version", () => {
  it("is pinned EXACTLY, not caret-ranged", () => {
    // THE CARET IS THE TRAP HERE. `^10.65.0` already permitted 10.66.0, so the
    // conflict would have healed on any `npm update` and re-appeared on any
    // fresh resolve that happened to pick differently. Worse, a caret would
    // silently pull 10.68.0+, which auto-instruments Durable Object classes and
    // reads wrangler config: a behaviour change on the money-write DO that this
    // session did not verify and was not scoped to. Exact, like `wrangler`.
    expect(PKG.dependencies["@sentry/cloudflare"]).toBe("10.66.0");
    expect(PKG.dependencies["@sentry/cloudflare"]).not.toMatch(/^[\^~]/);
  });

  it("the INSTALLED package accepts workers-types 5.x, which is the whole fix", async () => {
    // Read from the real installed manifest, not from a recollection of the
    // registry. 10.65.0 declared `^4.x` while wrangler declares `^5.x`, and that
    // contradiction is what a re-resolution trips over.
    const manifest = JSON.parse(
      read("node_modules/@sentry/cloudflare/package.json"),
    ) as { version: string; peerDependencies?: Record<string, string> };
    expect(manifest.version).toBe("10.66.0");
    expect(manifest.peerDependencies?.["@cloudflare/workers-types"]).toBe("^4.x || ^5.x");
  });

  it("and no legacy-peer-deps or overrides escape hatch was used", () => {
    // The fix has to be a real resolution, not a silenced check. An `overrides`
    // block or an `.npmrc` flag would make the tree install while leaving the
    // contradiction in place for the next reader to rediscover.
    const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(pkg.overrides).toBeUndefined();
    expect(pkg.resolutions).toBeUndefined();
    let npmrc = "";
    try {
      npmrc = read(".npmrc");
    } catch {
      npmrc = "";
    }
    expect(npmrc).not.toContain("legacy-peer-deps");
  });
});

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

  it("THE WORKER ENTRY REALLY USES THAT EXPRESSION, not a different one", () => {
    // Without this, the plant above tests a function the entry might not use.
    // 372 binding 4: assert on the value under test. (J05: was the inline
    // expression, now the imported sentryOptions.)
    const entry = read("workers/app.ts");
    expect(entry).toMatch(/withSentry<Env>\(\s*sentryOptions,/);
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

describe("PLANT 3: the Sentry surface Foxhound uses is unchanged", () => {
  it("exactly two APIs are used, and both are still exported", async () => {
    // The bump is only safe to the extent the surface is small. Pinning the
    // surface means a future bump that removes either one fails here rather
    // than at runtime on the day the DSN is set.
    const Sentry = await import("@sentry/cloudflare");
    expect(typeof Sentry.withSentry).toBe("function");
    expect(typeof Sentry.captureException).toBe("function");
  });

  it("and nothing new crept into the import surface", () => {
    // DERIVED over the tree: if a later session starts using a third Sentry API,
    // this goes red and the surface gets re-reviewed on purpose. Comments are
    // stripped, because this file DISCUSSES the package by
    // name (session 57's trap, walked into twice in this campaign already).
    const strip = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");

    const used = new Set<string>();
    for (const path of [
      "workers/app.ts",
      "app/lib/errors/sentry-options.ts",
      "app/lib/engine/outcomes.ts",
      "app/routes/app/disputes/detail.tsx",
      "app/routes/webhooks/stripe-platform.ts",
      "app/routes/webhooks/stripe.ts",
    ]) {
      const body = strip(read(path));
      for (const match of body.matchAll(/Sentry\.([a-zA-Z]+)/g)) used.add(match[1]);
      if (/\bwithSentry\s*[<(]/.test(body)) used.add("withSentry");
    }
    expect([...used].sort()).toEqual(["captureException", "withSentry"]);
  });
});
