import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import routes from "~/routes";

// TASK-foxhound-demo-system-completion.md Phase 1: a demo visitor must never
// be able to mutate anything, enforced server-side. The guard itself
// (appShellMiddleware, app/lib/auth/guards.ts) is a single choke point wired
// onto the whole app-shell route tree (app/layouts/app-shell.tsx), not a
// per-route check - so the actual way this protection could silently break
// is a NEW action route landing outside that subtree, or an existing one
// moving out of it. This is a structural regression guard for exactly that,
// mirroring test/admin-route-guard.test.ts's proven pattern: it does not
// re-test the guard predicate (demo-mode.test.ts already covers
// demoBlocksMethod/resolvesToDemo as pure functions); it proves route wiring
// can never drift a mutating route out from under the guard.

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

// Scans app/routes/app/ (the app-shell subtree's source directory) for any
// route module that exports an action - the ONLY kind of request the demo
// guard needs to stop. Reading real files (same pattern as
// test/helpers/inmemory-db.ts reading migration SQL) so a new action added
// later is picked up automatically; nobody has to remember to update a
// hardcoded list here.
const APP_ROUTES_DIR = fileURLToPath(new URL("../app/routes/app", import.meta.url));
const ACTION_EXPORT_PATTERN = /export\s+(async\s+)?function\s+action\b/;

function findActionRouteFiles(dir: string, relativeTo: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...findActionRouteFiles(full, relativeTo));
      continue;
    }
    if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
    const source = readFileSync(full, "utf8");
    if (ACTION_EXPORT_PATTERN.test(source)) {
      // routes.ts refers to files as "./routes/app/<...>" relative to app/.
      found.push(`./routes/app/${full.slice(relativeTo.length + 1)}`);
    }
  }
  return found;
}

describe("every action route in the app shell is guarded by appShellMiddleware", () => {
  const tree = routes as unknown as RouteConfigEntry[];

  it("finds action-exporting route files under app/routes/app/ (sanity: the scan itself works)", () => {
    const actionFiles = findActionRouteFiles(APP_ROUTES_DIR, APP_ROUTES_DIR);
    // Known today: disputes/detail, billing/index, settings/index,
    // settings/team, welcome (plus whatever admin/* actions exist - those are
    // double-guarded, see admin-route-guard.test.ts). A refactor that moves
    // or renames these should still find at least this many, or the scan
    // itself has gone stale and this test would otherwise pass vacuously.
    expect(actionFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("every action-exporting route file lives inside the app-shell layout subtree", () => {
    const actionFiles = findActionRouteFiles(APP_ROUTES_DIR, APP_ROUTES_DIR);
    const appShellNode = findByFile(tree, "./layouts/app-shell.tsx");
    expect(appShellNode).not.toBeNull();
    const guardedFiles = new Set(collectFiles(appShellNode!.children ?? []));

    for (const file of actionFiles) {
      expect(guardedFiles.has(file), `${file} exports an action but is not nested under app-shell.tsx`).toBe(
        true,
      );
    }
  });
});
