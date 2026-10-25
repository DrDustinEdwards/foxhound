
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

// Capsomer's real Button, wrapped only to keep hold of the click handler its
// rendered <button> carries, so a test can click the button the page really
// drew. The wrapper calls the real Button inside its own render (hooks and
// all) and returns its element unchanged, so the markup is Capsomer's.
const clicks = vi.hoisted(() => ({ handlers: [] as ((e: unknown) => void)[] }));
vi.mock("capsomer/react/button", async (importOriginal) => {
  const real = await importOriginal<typeof import("capsomer/react/button")>();
  function Button(props: Parameters<typeof real.Button>[0]) {
    const el = real.Button(props) as ReactElement<{ onClick?: (e: unknown) => void; children?: unknown }>;
    const btn = el.type === "button" ? el : (el.props.children as ReactElement<{ onClick?: (e: unknown) => void }>[])[0];
    if (btn.props.onClick) clicks.handlers.push(btn.props.onClick);
    return el;
  }
  return { ...real, Button };
});

const { default: CardUpdate } = await import("~/routes/utility/card-update");

// J62 (job_323ed2a2f37e), row F8: the hosted card update page at /p/:token,
// built from Capsomer's parts (Q12), amber and on the five text sizes
// (RULES.md 5.2), keeping Foxhound's own Checkout flow.
//
// Recova has no page here: its dunning, expiring-card and win-back emails link
// straight to a Stripe billing portal session (lib/recovery-execution.ts blob
// 3a8f8768 lines 208 to 233; app/api/cron/expiring-cards/route.ts line 201;
// app/api/cron/process-winback/route.ts line 313). Foxhound's page is the
// approved difference (APPROVED-DIFFERENCES, expiring-card and win-back lines,
// 2026-09-19), so its words are Foxhound's own and are pinned here unchanged:
// this job moves the parts, never the copy.
//
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass for one that does.

type Props = Parameters<typeof CardUpdate>[0];
type LoaderData = Props["loaderData"];

function render(loaderData: LoaderData, actionData?: { error: string }): string {
  const props = { loaderData, actionData, params: { token: "t" }, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(CardUpdate, props) }], {
    initialEntries: ["/p/t"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}





const READY: LoaderData = { state: "ready", amountCents: 9900, currency: "usd" };
const RESUBSCRIBE: LoaderData = { state: "resubscribe", planName: "Pro" };

/**
 * Render the page while a POST to its own action is in flight: the router's
 * navigation is "submitting" because the action never settles, which is what
 * a customer sees between pressing the button and Stripe's redirect.
 */
async function renderSubmitting(loaderData: LoaderData): Promise<string> {
  const props = { loaderData, params: { token: "t" }, matches: [] } as unknown as Props;
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(CardUpdate, props), action: () => new Promise(() => {}) }],
    { initialEntries: ["/p/t"] },
  );
  void router.navigate("/p/t", { formMethod: "post", formData: new FormData() });
  for (let i = 0; i < 20 && router.state.navigation.state !== "submitting"; i++) await Promise.resolve();
  expect(router.state.navigation.state, "the POST is in flight").toBe("submitting");
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("J62 review: the button while the Checkout redirect starts", () => {
  for (const [name, state] of [["recovery", READY], ["resubscribe", RESUBSCRIBE]] as const) {

    it(`${name}: a second press while pending is stopped before the form can submit again`, async () => {
      clicks.handlers = [];
      await renderSubmitting(state);
      expect(clicks.handlers.length, "the page drew Capsomer's button").toBeGreaterThan(0);
      const click = clicks.handlers[clicks.handlers.length - 1];
      const prevented = vi.fn();
      click({ preventDefault: prevented });
      expect(prevented).toHaveBeenCalledTimes(1);
    });

    it(`${name}: when idle the same press goes through (the guard discriminates)`, () => {
      clicks.handlers = [];
      render(state);
      const click = clicks.handlers[clicks.handlers.length - 1];
      const prevented = vi.fn();
      click({ preventDefault: prevented });
      expect(prevented).not.toHaveBeenCalled();
    });
  }
});
