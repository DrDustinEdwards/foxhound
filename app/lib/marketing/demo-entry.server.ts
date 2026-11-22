import { redirect } from "react-router";

import { ensureDemoSeeded } from "~/lib/demo/seed";
import { setDemoCookieHeader } from "~/lib/demo/session";

// The one allow-list every /demos/:product GET route resolves its redirect target from, so a target is never interpolated from a
// request. ensureDemoSeeded and setDemoCookieHeader live in app/lib/demo/ (the seeded account's AI firewall); this file only calls them.
const DEMO_ENTRY_TARGETS = {
  dashboard: "/console",
  recovery: "/recovery/dashboard",
  disputes: "/disputes/dashboard",
  intelligence: "/intelligence/dashboard",
} as const;

export type DemoEntryProduct = keyof typeof DEMO_ENTRY_TARGETS;

/** Seed the demo account (idempotent), set the read-only demo cookie, and redirect into the real product surface. */
export async function enterDemo(env: Env, product: DemoEntryProduct) {
  await ensureDemoSeeded(env);
  return redirect(DEMO_ENTRY_TARGETS[product], {
    headers: { "Set-Cookie": setDemoCookieHeader() },
  });
}
