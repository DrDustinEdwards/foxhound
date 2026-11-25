import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { data, RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import routes from "~/routes";
import { appShellMiddleware } from "~/lib/auth/guards";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { DEMO_SESSION_COOKIE, DEMO_SESSION_COOKIE_VALUE } from "~/lib/demo/constants";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import { getSession } from "~/lib/auth/session";

// The session lookup is mocked to "no session"; the test only needs the refusal.
vi.mock("~/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));

// A demo visitor must never mutate anything. appShellMiddleware is the single choke point on the app-shell
// subtree, so the risk is an action route landing outside that subtree; this scans for it.

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
    // Guards the scan itself against going stale and passing vacuously.
    expect(actionFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("every action-exporting route file lives inside the app-shell layout subtree", () => {
    const actionFiles = findActionRouteFiles(APP_ROUTES_DIR, APP_ROUTES_DIR);
    const appShellNode = findByFile(tree, "./layouts/app-shell.tsx");
    expect(appShellNode).not.toBeNull();
    const guardedFiles = new Set(collectFiles(appShellNode!.children ?? []));

    for (const file of actionFiles) {
      expect(
        guardedFiles.has(file),
        `${file} exports an action but is not nested under app-shell.tsx`,
      ).toBe(true);
    }
  });
});

// The client-side interception is not the boundary; the server-side 405 is.
describe("appShellMiddleware still refuses a mutating request in demo mode", () => {
  it("throws the read-only 405 for a POST carrying the demo cookie with no session", async () => {
    const request = new Request("http://localhost/recovery/payments/pay_1", {
      method: "POST",
      headers: { cookie: `${DEMO_SESSION_COOKIE}=${DEMO_SESSION_COOKIE_VALUE}` },
    });
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext });
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
    // Refused before any session work.
    expect(getSession).not.toHaveBeenCalled();
  });

  it("the theme and account-switch endpoints refuse a demo POST before reading a session", async () => {
    const { action: themeAction } = await import("~/routes/api/theme");
    const { action: switchAction } = await import("~/routes/api/account-switch");
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext });
    for (const [path, action] of [
      ["/api/theme", themeAction],
      ["/api/account/switch", switchAction],
    ] as const) {
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
