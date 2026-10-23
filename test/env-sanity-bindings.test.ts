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

  it("every row getEnvSanity calls a binding is declared in wrangler.jsonc", () => {
    const declared = declaredBindings();
    const claimed = getEnvSanity({} as Env)
      .filter((r) => r.kind === "binding")
      .map((r) => r.name);
    const phantoms = claimed.filter((n) => !declared.has(n));
    expect(phantoms).toEqual([]);
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
