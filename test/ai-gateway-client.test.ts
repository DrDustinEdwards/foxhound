import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createAnthropicClient } from "~/lib/ai/client";

// SESSION 54 / 346: AI Gateway in front of the Anthropic calls.
//
// Where the calls go (gateway or direct, the token, body logging off) is
// site-runtime's anthropicRoute and is tested there, once. What these plants
// defend is that the decision stays in one place here too: four call sites
// each built their own client, and four copies of a routing decision is four
// chances to get it wrong.

/** Every module that builds an Anthropic client. The list is DERIVED from a
 *  grep in the coverage plant below, so a fifth call site added tomorrow fails
 *  that test rather than being quietly missed. */
/** Every .ts under app/ whose source contains `needle`, tree-walked so an
 *  uncommitted file counts. Paths are repo-relative with forward slashes. */
function filesContaining(needle: string): string[] {
  const root = fileURLToPath(new URL("../app", import.meta.url));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (readFileSync(full, "utf8").includes(needle)) {
        found.push(`app/${full.slice(root.length + 1).split("\\").join("/")}`);
      }
    }
  };
  walk(root);
  return found.sort();
}

const CALL_SITES = [
  "app/lib/recovery/email-generation.ts",
  "app/lib/disputes/evidence.ts",
  "app/lib/intelligence/narrative.ts",
  "app/lib/marketing/home-email-sample.server.ts",
  // Session 58's win-back generator. THE GUARD CAUGHT THIS ITSELF: the derived
  // list went from four to five the moment the new file was committed, which is
  // the both-directions failure this plant exists for.
  "app/lib/recovery/winback-generation.ts",
  // Session 69's audit summary. THE GUARD CAUGHT THIS ONE TOO, and in catching
  // it showed its own blind spot; see the derivation below.
  "app/lib/audit/summary.server.ts",
];

describe("the factory", () => {
  it("refuses to build a client with no key, as every call site did before", () => {
    expect(() => createAnthropicClient({} as unknown as Env)).toThrow("ANTHROPIC_API_KEY");
  });
});

describe("PLANT 3: no call site builds its own client", () => {
  it("EVERY call site goes through the factory", () => {
    for (const path of CALL_SITES) {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} must use the factory`).toContain("createAnthropicClient(env)");
      expect(source, `${path} must not construct its own client`).not.toContain("new Anthropic(");
    }
  });

  it("AND THE LIST IS DERIVED, so a sixth call site cannot be missed", () => {
    // The expected set comes from the tree, not from the constant above, and
    // fails in BOTH directions: a new constructor anywhere, or a listed file
    // that stopped calling the factory.
    //
    // IT WALKS THE TREE RATHER THAN THE INDEX, as of session 69. It used
    // `git grep`, which cannot see a file that has not been committed, so it
    // stayed green while a sixth call site sat uncommitted in the working tree
    // and only fired one commit later. A guard that reports a violation after
    // the fact was not watching at the moment that mattered.
    const hits = filesContaining("createAnthropicClient(env)").filter(
      (path) => path !== "app/lib/ai/client.ts",
    );
    expect(hits).toEqual([...CALL_SITES].sort());

    // The factory is the only module allowed to construct one.
    expect(filesContaining("new Anthropic(")).toEqual(["app/lib/ai/client.ts"]);
  });
});
