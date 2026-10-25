import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// RULING 308 item 2: every Stripe signature verification must use the DEFAULT
// replay tolerance. Stripe's default is 300 seconds; the tolerance is the FOURTH
// argument to constructEvent/constructEventAsync, so passing three arguments is
// what keeps the default. A widened tolerance lengthens the window in which a
// captured request can be replayed against a money path.
//
// MEASURED at HEAD before this was written: exactly ONE call site,
// app/lib/stripe/webhook.ts, and both webhook endpoints route through it.
//
// UPDATED AT 312: this note used to add "the workers/webhooks/*.ts files are
// TODO stubs with no call". Those files are DELETED. 311 found that all 22 files
// under workers/crons, workers/webhooks and workers/queues were one-line TODO
// comments shadowing the real implementations, and that they had already misled
// two sessions into misreading the system; 312 purged them. The scan below still
// walks workers/, which now holds only real modules.
//
// BOUND, stated per 246: this is a SOURCE-SHAPE guard, not a behavioral one.
// Proving the effective tolerance at runtime would mean signing a payload with a
// backdated timestamp against a real secret, and STRIPE_WEBHOOK_SECRET is not
// configured on this Worker (measured: 8 secrets set, that one absent). So this
// catches a widened override being ADDED; it does not measure the window Stripe
// applies. That is said plainly rather than dressed up.

/** Comment-stripped, because webhook.ts NAMES constructEvent four times in its
 *  header prose while calling it once. An uncomment-stripped count would read 5
 *  and this file would fail against correct code. Sixth instance of the
 *  self-match class in this campaign; applied up front this time. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const SOURCES = [...tsFilesUnder("app"), ...tsFilesUnder("workers")].map((path) => ({
  path,
  code: strip(readFileSync(path, "utf8")),
}));

/** Files that actually CALL a construct-event function, comments excluded. */
const callSites = SOURCES.filter((f) => /\bconstructEvent(Async)?\s*\(/.test(f.code));

describe("308 item 2: the Stripe replay window is Stripe's default", () => {
  it("has exactly ONE signature-verification call site", () => {
    // A second call site is the realistic regression: a new endpoint verifying
    // inline instead of routing through the shared helper, and quietly choosing
    // its own tolerance. The count is the guard.
    expect(callSites.map((f) => f.path.replace(/\\/g, "/"))).toEqual([
      "app/lib/stripe/webhook.ts",
    ]);
  });

  it("passes NO tolerance argument, so Stripe's 300s default applies", () => {
    const [site] = callSites;
    expect(site, "no construct-event call site found at all").toBeDefined();
    const call = /constructEvent(?:Async)?\s*\(([\s\S]*?)\)\s*;/.exec(site.code);
    expect(call, "could not isolate the call expression").not.toBeNull();
    // Top-level comma count: 3 arguments means payload, signature, secret and
    // nothing else. A 4th is the tolerance override this ruling forbids.
    const args = call![1]
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    expect(args).toHaveLength(3);
    expect(args.some((a) => /^\d+$/.test(a)), "a numeric 4th argument is a tolerance override").toBe(
      false,
    );
  });

  it("REGRESSION GUARD: no source anywhere sets a stripe tolerance option", () => {
    // The other way to widen it: an options object carrying `tolerance`. This
    // guard is proven non-vacuous by its own plant per 296.
    const offenders = SOURCES.filter((f) => /\btolerance\s*:/.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
