import { describe, expect, it } from "vitest";

import routes from "~/routes";

// Structural regression guard (Phase 7 Pass 1): every /admin/* route file
// MUST be reachable only through the admin-guard pathless layout
// (app/layouts/admin-guard.tsx), which attaches adminOnlyMiddleware
// (app/lib/auth/guards.ts, already unit-tested via isAdminEmail in
// auth-roles.test.ts: a non-admin is rejected with a 404 at the loader, and
// since actions run through the same route tree, at the action too). This
// test does not re-test the guard predicate itself; it proves route wiring
// can never silently drift a new admin route outside the guarded subtree,
// which is the actual way this kind of route could stop being protected.

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

  it("every route file under app/routes/admin/ lives inside the admin-guard layout subtree", () => {
    const allFiles = collectFiles(tree);
    const adminFiles = allFiles.filter((f) => f.startsWith("./routes/admin/"));
    // Sanity: the fixture itself must find the 11 admin pages, or this test
    // is silently checking nothing (a routes.ts refactor that renames the
    // directory would otherwise pass vacuously).
    expect(adminFiles.length).toBeGreaterThanOrEqual(11);

    const guardNode = findByFile(tree, "./layouts/admin-guard.tsx");
    expect(guardNode).not.toBeNull();
    const guardedFiles = new Set(collectFiles(guardNode!.children ?? []));

    for (const file of adminFiles) {
      expect(guardedFiles.has(file), `${file} is not nested under admin-guard.tsx`).toBe(true);
    }
  });

  it("the admin-guard layout itself lives inside the app-shell layout (session + account required first)", () => {
    const appShellNode = findByFile(tree, "./layouts/app-shell.tsx");
    expect(appShellNode).not.toBeNull();
    const shellFiles = new Set(collectFiles(appShellNode!.children ?? []));
    expect(shellFiles.has("./layouts/admin-guard.tsx")).toBe(true);
  });
});
