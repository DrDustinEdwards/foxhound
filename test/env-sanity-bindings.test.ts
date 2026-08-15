import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getEnvSanity } from "~/lib/admin/operations.server";

// EMAIL_DLQ was a PHANTOM sanity row: declared in env.d.ts and listed by
// getEnvSanity while bound nowhere in wrangler.jsonc, so /admin/operations
// reported a binding that could never be set. 287 named it, 289 assigned the
// repair, and this file is the guard that stops another one appearing.
//
// The instrument matters more than the one row. 287's own reasoning: "a phantom
// row in the sanity instrument can mask a real missing binding in an audit."
// So this DERIVES the truth from wrangler.jsonc rather than restating a list,
// which is the repo's own convention for a hardcoded list mirroring external
// state (see test/admin-known-migrations.test.ts for the same shape).

const WRANGLER = readFileSync("wrangler.jsonc", "utf8");

/** Every binding name wrangler.jsonc actually declares.
 *  D1/KV/queues use `"binding"`, Durable Objects and the email send binding use
 *  `"name"`, so both spellings are collected. Comments are stripped first: this
 *  file is JSONC and its comments discuss binding names at length, which a bare
 *  match would read as declarations. */
function declaredBindings(): Set<string> {
  const withoutComments = WRANGLER.replace(/\/\/[^\n]*/g, "");
  const names = new Set<string>();
  for (const m of withoutComments.matchAll(/"(?:binding|name)"\s*:\s*"([A-Z][A-Z0-9_]*)"/g)) {
    names.add(m[1]);
  }
  return names;
}

describe("env sanity: no phantom bindings", () => {
  it("the matcher finds the bindings that really are declared", () => {
    // Calibrated before use (239): if this control ever goes empty the guard
    // below would pass vacuously against a matcher that reads nothing.
    const declared = declaredBindings();
    expect(declared.size).toBeGreaterThanOrEqual(5);
    // APP_KV LEFT THIS CALIBRATION LIST AT 310, adjudicated rather than silently
    // dropped. It was a sample name proving the matcher reads real declarations,
    // correct while the KV binding existed and false the moment 310 removed it
    // for having ZERO consumers. It was never a guard ABOUT APP_KV: the two
    // directional assertions below are what police the sanity surface, and both
    // still pass precisely because the binding and the sanity row were removed
    // TOGETHER. Had only one side been removed, one of them would have failed,
    // which is the loop working.
    for (const known of ["DB", "EMAIL", "MONEY_WRITER", "CRON_LOCK"]) {
      expect(declared).toContain(known);
    }
    // The removal must be real on the wrangler side, not just absent from the
    // list above: this fails if the binding is ever re-added without a consumer.
    expect(declared).not.toContain("APP_KV");
    // And it must NOT pick names out of prose, which is what stripping the
    // comments buys: EMAIL_DLQ is still discussed there and is not a binding.
    expect(WRANGLER).toContain("EMAIL_DLQ");
    expect(declared).not.toContain("EMAIL_DLQ");
  });

  it("every row getEnvSanity calls a binding is declared in wrangler.jsonc", () => {
    const declared = declaredBindings();
    const claimed = getEnvSanity({} as Env)
      .filter((r) => r.kind === "binding")
      .map((r) => r.name);
    const phantoms = claimed.filter((n) => !declared.has(n));
    expect(phantoms).toEqual([]);
  });

  it("EMAIL_DLQ is gone from the sanity list and the ambient Env", () => {
    expect(getEnvSanity({} as Env).map((r) => r.name)).not.toContain("EMAIL_DLQ");
    expect(readFileSync("env.d.ts", "utf8")).not.toContain("EMAIL_DLQ");
  });

  // THE INVERSE GAP IS CLOSED 2026-08-14 under 290. RATE_LIMITER was declared in
  // wrangler.jsonc and missing from getEnvSanity, so the sanity surface
  // under-reported a live binding: exactly the masking 287 predicted a phantom
  // would hide. The previous version of this test PINNED that gap as the measured
  // state and was written to fail the moment it was fixed, which is what happened
  // and what prompted this edit rather than a silent drift. It is now the mirror
  // of the assertion above, so the two together close the loop in both directions:
  // no sanity row without a declaration, and no declaration without a sanity row.
  it("every binding wrangler.jsonc declares appears in the sanity list", () => {
    const declared = declaredBindings();
    const claimed = new Set(
      getEnvSanity({} as Env)
        .filter((r) => r.kind === "binding")
        .map((r) => r.name),
    );
    const missing = [...declared].filter((n) => !claimed.has(n));
    expect(missing).toEqual([]);
  });
});
