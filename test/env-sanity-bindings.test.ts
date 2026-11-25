import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getEnvSanity } from "~/lib/admin/operations.server";

// Derives the truth from wrangler.jsonc so the sanity list can neither claim a binding that is not
// declared nor omit one that is.

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
