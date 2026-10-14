import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import routes from "~/routes";

// Structural regression guard (Phase 7 Pass 1, re-pointed by job_6566f4776fdf):
// every /admin/* route file MUST be reachable only through the admin-shell
// layout (app/layouts/admin-shell.tsx), whose middleware verifies Cloudflare
// Access's JWT and the ADMIN_EMAIL allowlist (app/lib/auth/access.server.ts,
// tested in admin-access.test.ts) and 404s anything else, at the loader and,
// since actions run through the same route tree, at the action too. This test
// proves route wiring can never silently drift a new admin route outside the
// guarded subtree, which is the actual way this kind of route could stop
// being protected.

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
    // Sanity: the fixture itself must find the 12 admin pages, or this test
    // is silently checking nothing (a routes.ts refactor that renames the
    // directory would otherwise pass vacuously).
    expect(adminFiles.length).toBeGreaterThanOrEqual(12);

    const guardNode = findByFile(tree, "./layouts/admin-shell.tsx");
    expect(guardNode).not.toBeNull();
    const guardedFiles = new Set(collectFiles(guardNode!.children ?? []));

    for (const file of adminFiles) {
      expect(guardedFiles.has(file), `${file} is not nested under admin-shell.tsx`).toBe(true);
    }
  });

  it("the emergency brake specifically is inside the guard", () => {
    // Named explicitly rather than relying on the sweep above. The brake pauses
    // processing for every merchant on the platform and can disable the recovery
    // tick, so it is the single admin route where a wiring mistake is worst, and
    // it should fail by name rather than as one entry in a set.
    const guardNode = findByFile(tree, "./layouts/admin-shell.tsx");
    const guardedFiles = new Set(collectFiles(guardNode?.children ?? []));
    expect(guardedFiles.has("./routes/admin/brake.tsx")).toBe(true);
  });

  it("the admin-shell layout is NOT under the merchant app shell (Access, not a merchant session, signs admins in)", () => {
    const appShellNode = findByFile(tree, "./layouts/app-shell.tsx");
    expect(appShellNode).not.toBeNull();
    const shellFiles = new Set(collectFiles(appShellNode!.children ?? []));
    expect(shellFiles.has("./layouts/admin-shell.tsx")).toBe(false);
    expect([...shellFiles].some((f) => f.startsWith("./routes/admin/"))).toBe(false);
  });

  it("the admin-shell layout carries the Access middleware", () => {
    const source = readFileSync("app/layouts/admin-shell.tsx", "utf8");
    expect(source).toContain("export const middleware");
    expect(source).toContain("getAdminSession(env, request)");
    expect(source).toContain('status: 404');
  });
});
