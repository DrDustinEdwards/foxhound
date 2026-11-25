import { describe, expect, it, vi } from "vitest";

import routes from "~/routes";

// Every /admin/* route must live under the admin-shell layout, whose middleware checks Access and ADMIN_EMAIL.

interface RouteConfigEntry {
  file: string;
  children?: RouteConfigEntry[];
}

function collectFiles(entries: RouteConfigEntry[]): string[] {
  return entries.flatMap((e) => [e.file, ...(e.children ? collectFiles(e.children) : [])]);
}

function findByFile(entries: RouteConfigEntry[], file: string): RouteConfigEntry | null {
  for (const e of entries) {
    if (e.file === file) return e;
    if (e.children) {
      const found = findByFile(e.children, file);
      if (found) return found;
    }
  }
  return null;
}

describe("admin route guard wiring", () => {
  const tree = routes as unknown as RouteConfigEntry[];

  it("every route file under app/routes/admin/ lives inside the admin-shell layout subtree", () => {
    const allFiles = collectFiles(tree);
    const adminFiles = allFiles.filter((f) => f.startsWith("./routes/admin/"));
    expect(adminFiles.length).toBeGreaterThanOrEqual(12);

    const guardNode = findByFile(tree, "./layouts/admin-shell.tsx");
    expect(guardNode).not.toBeNull();
    const guardedFiles = new Set(collectFiles(guardNode!.children ?? []));

    for (const file of adminFiles) {
      expect(guardedFiles.has(file), `${file} is not nested under admin-shell.tsx`).toBe(true);
    }
  });
});

describe("the /admin gate (admin-shell middleware)", () => {
  const dev = { ACCESS_DEV_BYPASS: "1", ADMIN_EMAIL: "admin@example.com" } as unknown as Env;
  const run = async (env: Env, headers: Record<string, string>) => {
    const { middleware } = await import("~/layouts/admin-shell");
    const context = { get: () => ({ env }), set: () => {} };
    const next = vi.fn(async () => new Response("ran"));
    const request = new Request("http://localhost:5173/admin/brake", { method: "POST", headers });
    const outcome = await Promise.resolve(
      middleware[1]!({ request, context, params: {} } as never, next as never),
    ).catch((e: unknown) => e);
    return { outcome: outcome as Response, ran: next.mock.calls.length > 0 };
  };

  it("answers 404 and runs nothing when there is no admin session", async () => {
    const { outcome, ran } = await run({ ADMIN_EMAIL: "admin@example.com" } as unknown as Env, {});
    expect(ran).toBe(false);
    expect(outcome.status).toBe(404);
  });

  it("lets a same-origin POST through and answers a cross-site one 403, for a signed-in admin", async () => {
    expect((await run(dev, { Origin: "http://localhost:5173" })).ran).toBe(true);
    for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }]) {
      const { outcome, ran } = await run(dev, headers);
      expect(ran).toBe(false);
      expect(outcome.status).toBe(403);
    }
  });
});
