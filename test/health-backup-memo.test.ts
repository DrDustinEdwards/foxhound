import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { loader, resetHealthMemoForTests } from "~/routes/health";

// job_7bbec6ab48d1: binding BACKUPS turns every /health hit into an R2 list
// (a billed Class A operation) on a public, unrate-limited route. The memo
// bounds that to one read per isolate per five minutes.

function bucket() {
  const marker = JSON.stringify({
    exported_at: "2026-10-11T03:00:00.000Z",
    keys: [],
    tables: [],
    fts: [],
    excluded: [],
  });
  const calls = { list: 0 };
  return {
    calls,
    put: async () => undefined,
    get: async () => ({ text: async () => marker }),
    list: async () => {
      calls.list += 1;
      return { objects: [{ key: "backups/json/2026-10-11T03-00-00Z/_complete.json" }], truncated: false };
    },
  };
}

function hit(env: Env) {
  const context = {
    get: (key: unknown) => {
      if (key !== cloudflareContext) throw new Error("unexpected context key");
      return { env, ctx: {} as ExecutionContext, nonce: "n" };
    },
  };
  return loader({ context } as unknown as Parameters<typeof loader>[0]);
}

beforeEach(() => {
  resetHealthMemoForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T09:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("/health backup memo", () => {
  it("repeat hits inside five minutes read R2 once", async () => {
    const b = bucket();
    const env = { BACKUPS: b } as unknown as Env;
    const first = await (await hit(env)).json();
    vi.setSystemTime(new Date("2026-10-11T09:04:59.000Z"));
    const second = await (await hit(env)).json();
    expect(b.calls.list).toBe(1);
    expect(second).toEqual(first);
    expect((first as { backup: { age_hours: number } }).backup.age_hours).toBe(6);
  });

  it("PLANT: after five minutes it reads R2 again", async () => {
    const b = bucket();
    const env = { BACKUPS: b } as unknown as Env;
    await hit(env);
    vi.setSystemTime(new Date("2026-10-11T09:05:00.000Z"));
    await hit(env);
    expect(b.calls.list).toBe(2);
  });

  it("an unreadable bucket is reported, and retried after the window", async () => {
    const b = bucket();
    const failing = { ...b, list: async () => Promise.reject(new Error("r2 down")) };
    const first = (await (await hit({ BACKUPS: failing } as unknown as Env)).json()) as {
      backup: { warning: string; age_hours: null };
    };
    expect(first.backup.warning).toMatch(/unreadable: r2 down/);
    expect(first.backup.age_hours).toBeNull();
    vi.setSystemTime(new Date("2026-10-11T09:05:00.000Z"));
    await hit({ BACKUPS: b } as unknown as Env);
    expect(b.calls.list).toBe(1);
  });
});
