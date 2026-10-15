import { redirect } from "react-router";

import { ensureDemoSeeded } from "~/lib/demo/seed";
import { setDemoCookieHeader } from "~/lib/demo/session";

// TASK-foxhound-demo-entry-parity.md item 1: the one allow-list every real
// /demos/:product GET route resolves its redirect target from, so a target
// is never interpolated from a request. Reused as-is here (not touched):
// ensureDemoSeeded and setDemoCookieHeader still live in app/lib/demo/, the
// seeded account's AI firewall, and this file only calls them.
export const DEMO_ENTRY_TARGETS = {
  dashboard: "/console",
  recovery: "/recovery/dashboard",
  disputes: "/disputes/dashboard",
  intelligence: "/intelligence/dashboard",
} as const;

export type DemoEntryProduct = keyof typeof DEMO_ENTRY_TARGETS;

/** Seed the demo account (idempotent), set the read-only demo cookie, and
 *  redirect straight into the real product surface. */
export async function enterDemo(env: Env, product: DemoEntryProduct) {
  await ensureDemoSeeded(env);
  return redirect(DEMO_ENTRY_TARGETS[product], {
    headers: { "Set-Cookie": setDemoCookieHeader() },
  });
}
