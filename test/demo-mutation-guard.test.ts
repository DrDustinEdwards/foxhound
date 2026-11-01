import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { data, RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import routes from "~/routes";
import { appShellMiddleware } from "~/lib/auth/guards";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DEMO_SESSION_COOKIE, DEMO_SESSION_COOKIE_VALUE } from "~/lib/demo/constants";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import { getSession } from "~/lib/auth/session";

// getSession makes a real Better Auth call (app/lib/auth/session.ts); the
// test below only cares that appShellMiddleware still refuses a mutating
// request when there is no session, so the session lookup is mocked to that
// one case rather than standing up Better Auth.
vi.mock("~/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));

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

// TASK-foxhound-demo-inline-refusal.md: the client-side interception
// (DemoGuardedForm) added in this task is deliberately NOT the security
// boundary, only a better experience for the common case. This proves the
// real boundary - appShellMiddleware's demoBlocksMethod check and its
// throw data(DEMO_READ_ONLY_MESSAGE, {status: 405}) - is byte-for-byte
// unchanged and still refuses a mutating request server-side, independent
// of anything the client does.
describe("appShellMiddleware still refuses a mutating request in demo mode", () => {
  it("throws the read-only 405 for a POST carrying the demo cookie with no session", async () => {
    const request = new Request("http://localhost/recovery/payments/pay_1", {
      method: "POST",
      headers: { cookie: `${DEMO_SESSION_COOKIE}=${DEMO_SESSION_COOKIE_VALUE}` },
    });
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "" });
    const next = vi.fn();

    await expect(
      appShellMiddleware(
        {
          request,
          context,
          params: {},
          url: new URL(request.url),
          pattern: "/recovery/payments/:id",
        },
        next,
      ),
    ).rejects.toEqual(data(DEMO_READ_ONLY_MESSAGE, { status: 405 }));

    expect(next).not.toHaveBeenCalled();
    // Hard rule 10: refused before any session work, not after it.
    expect(getSession).not.toHaveBeenCalled();
  });

  it("the theme and account-switch endpoints refuse a demo POST before reading a session", async () => {
    const { action: themeAction } = await import("~/routes/api/theme");
    const { action: switchAction } = await import("~/routes/api/account-switch");
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "" });
    for (const [path, action] of [["/api/theme", themeAction], ["/api/account/switch", switchAction]] as const) {
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { cookie: `${DEMO_SESSION_COOKIE}=${DEMO_SESSION_COOKIE_VALUE}` },
      });
      const response = (await action({ request, context, params: {} } as never)) as Response;
      expect(response.status, path).toBe(405);
    }
    expect(getSession).not.toHaveBeenCalled();
  });
});
