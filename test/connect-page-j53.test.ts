import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

const { default: Connect } = await import("~/routes/auth/connect");

// J53, row A6: /connect, the Stripe consent page.
//
// Recova is the spec for the page's content, layout and features: its
// app/connect/page.tsx (blob a79ee373, 4984 bytes), read whole. One 480px card
// centered on the page, holding the h1 "Connect your Stripe account", the line
// under it, the error notice, the access-disclosure panel ruling 20(d) owes,
// the full-width "Connect Stripe" button, "Not ready? See a demo first" and
// "Manage account". Its parts are Capsomer's, amber, on the five
// text sizes.
//
// The Stripe scope is never narrowed to fit the copy: the copy is fixed to fit
// the scope. Recova's own lines are kept word for word where
// they are true of Foxhound; the three that are not are named in the tests
// below with the reason.
//
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass for one that does.

type Props = Parameters<typeof Connect>[0];
type LoaderData = Props["loaderData"];

function render(loaderData: LoaderData, actionData?: { error: string }): string {
  const props = { loaderData, actionData, params: {}, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(Connect, props) }], {
    initialEntries: ["/connect"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Visible text, tags stripped and whitespace collapsed, for order checks. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
}

const CONNECT: LoaderData = {
  hasAccount: true,
  accountName: "Acme Supply Co.",
  userName: "Dana",
  hasConnection: false,
  isOwner: true,
  stripeEnabled: true,
  error: null,
};

describe("J53: the access-disclosure panel (ruling 20(d)), true of Foxhound's scope", () => {

  it("never claims Foxhound charges only on invoices the merchant issued, while win-back checkout exists", () => {
    // The win-back resubscribe checkout makes a new subscription, invoice and
    // charge on the merchant's account when the customer completes it, so
    // "outside an invoice you already issued" is false while it exists.
    const t = text(render(CONNECT));
    expect(t).not.toMatch(/outside an invoice you already issued/i);
  });
});

describe("J53: Stripe's errors in Recova's words, in a Capsomer alert above the panel", () => {

  it("a Stripe account live on another Foxhound account says so, and names no account", () => {
    const t = text(render({ ...CONNECT, error: "stripe_account_already_connected" }));
    expect(t).toContain("This Stripe account is already connected to a Foxhound account.");
    expect(t).not.toContain("Please try again");
  });
});
