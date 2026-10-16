import type { Theme } from "~/lib/theme";

// The account page's theme save (Recova's ThemeToggle, blob 8f32b6c7), apart
// from the component so it can be tested without a browser. Client-safe.

export type ThemeChoiceOutcome = "saved" | "failed" | "demo";

/**
 * Save a theme choice to the account through /api/theme (Recova's
 * /api/account/theme).
 *
 * IN THE DEMO IT SAVES NOTHING. /api/theme writes the signed-in person's own
 * active account, so a person viewing the demo over their session would
 * otherwise change their real account from a read-only page. The demo refuses
 * here the way DemoGuardedForm refuses every other demo write, before anything
 * leaves the browser.
 *
 * A refused response and a lost connection are both "failed": Recova shows the
 * same line for either.
 */
export async function chooseTheme(
  theme: Theme,
  opts: { isDemo: boolean; fetcher?: typeof fetch },
): Promise<ThemeChoiceOutcome> {
  if (opts.isDemo) return "demo";
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  };
  try {
    // The global fetch is called as itself, never as a detached reference,
    // which some browsers refuse ("Illegal invocation").
    const res = opts.fetcher ? await opts.fetcher("/api/theme", init) : await fetch("/api/theme", init);
    return res.ok ? "saved" : "failed";
  } catch {
    return "failed";
  }
}
