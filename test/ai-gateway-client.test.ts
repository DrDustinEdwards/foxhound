import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AI_GATEWAY_NO_BODY_LOG_HEADER,
  createAnthropicClient,
} from "~/lib/ai/client";

// SESSION 54 / 346: AI Gateway in front of the Anthropic calls.
//
// The change is a base URL and a logging header, decided in ONE place. What
// these plants defend is that the decision stays in one place: four call sites
// each built their own client, and four copies of a routing decision is four
// chances to get it wrong.
//
// THE LOAD-BEARING ASSERTION is the logging header. AI Gateway logs request and
// response BODIES by default, and two of the four call sites put real customer
// data in those bodies.

const GATEWAY =
  "https://gateway.ai.cloudflare.com/v1/acct_test/foxhound-test/anthropic";

function envWith(overrides: Record<string, string | undefined> = {}): Env {
  return { ANTHROPIC_API_KEY: "sk-ant-test", ...overrides } as unknown as Env;
}

// THE ASSERTIONS ARE TAKEN AT THE WIRE, not off the client object. The SDK keeps
// baseURL and defaultHeaders in a private `_options`, and a test that reads a
// private field proves the constructor was called, never that the request
// carries what it should. Recording the actual fetch proves the request.
const sent: { url: string; headers: Record<string, string> }[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  sent.length = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (v, k) => {
        headers[k.toLowerCase()] = v;
      },
    );
    sent.push({ url, headers });
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "{}" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function callOnce(env: Env): Promise<void> {
  await createAnthropicClient(env).messages.create({
    model: "claude-sonnet-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
}

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

describe("PLANT 1: the base URL is opt in, by environment", () => {
  it("THE REQUEST GOES TO THE GATEWAY when AI_GATEWAY_BASE_URL is set", async () => {
    await callOnce(envWith({ AI_GATEWAY_BASE_URL: GATEWAY }));

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${GATEWAY}/v1/messages`);
  });

  it("refuses to build a client with no key, as every call site did before", () => {
    expect(() => createAnthropicClient({} as unknown as Env)).toThrow("ANTHROPIC_API_KEY");
  });
});

describe("PLANT 2: request bodies are never logged by the gateway", () => {
  it("THE HEADER IS ON THE WIRE, gateway or not", async () => {
    await callOnce(envWith({ AI_GATEWAY_BASE_URL: GATEWAY }));
    await callOnce(envWith());

    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.headers[AI_GATEWAY_NO_BODY_LOG_HEADER]).toBe("false");
    }
  });

  it("THE HEADER IS THE ONE CLOUDFLARE DOCUMENTS, spelled exactly", () => {
    // A near-miss spelling would be silently ignored by the gateway and the
    // bodies would be stored, which is the failure this pins.
    expect(AI_GATEWAY_NO_BODY_LOG_HEADER).toBe("cf-aig-collect-log-payload");
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
