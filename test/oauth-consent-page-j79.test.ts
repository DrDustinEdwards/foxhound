
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";


const { default: Authorize } = await import("~/routes/oauth/authorize");

// J79, row A9: the consent page, rendered. Recova is the spec for its content
// and layout (app/oauth/authorize/page.tsx 63884241 and ConsentButtons.tsx
// eb31e8e9, read whole): one 460px card centered on a full-height page with no
// site navigation (Recova's root layout has none), the wordmark, the h1 naming
// the client, the line under it, the account box, what the client can do, the
// error, Allow access and Deny side by side, and the closing line. The parts
// are Capsomer's, amber, on the five text sizes.

type Props = Parameters<typeof Authorize>[0];
type LoaderData = Props["loaderData"];

const OK: LoaderData = {
  ok: true,
  clientId: "c1",
  clientName: "Claude",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  state: "st",
  codeChallenge: "x".repeat(43),
  wantsWrite: false,
  accountId: "acct_b",
  accountName: "Acme Supply Co.",
  email: "dana@acme.test",
};

function render(loaderData: LoaderData, actionData?: { error: string }): string {
  const props = { loaderData, actionData, params: {}, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(Authorize, props) }], {
    initialEntries: ["/oauth/authorize"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}




describe("A9: Recova's card, in Recova's order", () => {

  it("offers one choice, Allow changes, ticked only when the client asked to write", () => {
    const html = render(OK);
    expect(html).not.toMatch(/All accounts/);
    const box = /<input[^>]*name="allow_write"[^>]*>/.exec(html)?.[0] ?? "";
    expect(box, "the read-only grant is the default").not.toMatch(/checked/);
    expect(render({ ...OK, wantsWrite: true })).toMatch(/<input[^>]*name="allow_write"[^>]*checked/);
    // The write line sits beside the box, not in the list every grant gets.
    const list = /<ul[^>]*aria-labelledby="oauth-can"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
    expect(list).not.toMatch(/Change your settings/);
    expect(html).toMatch(/Change your settings and alerts/);
  });
});
