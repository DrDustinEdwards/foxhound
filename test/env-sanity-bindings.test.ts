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
    for (const known of ["DB", "APP_KV", "EMAIL", "MONEY_WRITER", "CRON_LOCK"]) {
      expect(declared).toContain(known);
    }
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

  // REPORTED, NOT REPAIRED (190), and deliberately NOT asserted so this file
  // stays green while the finding stands: the INVERSE gap is real. RATE_LIMITER
  // is declared in wrangler.jsonc and is absent from getEnvSanity's list, so the
  // sanity surface under-reports a live binding. That is exactly the masking 287
  // predicted a phantom would hide, found by this session's own measurement, and
  // its repair is unassigned. When it is assigned, the assertion to add is the
  // mirror of the one above: every declared binding appears in the sanity list.
  it("documents the reported inverse gap without asserting it", () => {
    const declared = declaredBindings();
    const claimed = new Set(
      getEnvSanity({} as Env)
        .filter((r) => r.kind === "binding")
        .map((r) => r.name),
    );
    const missing = [...declared].filter((n) => !claimed.has(n));
    // Pinned as the MEASURED state on 2026-08-14, so this test starts failing
    // the moment the gap is fixed or a second one appears, which is the prompt
    // to update the record rather than a silent drift.
    expect(missing).toEqual(["RATE_LIMITER"]);
  });
});
