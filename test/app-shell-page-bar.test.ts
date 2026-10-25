import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import AppLayout from "~/layouts/app-shell";
import { handle as disputeDetailHandle } from "~/routes/app/disputes/detail";

// job_490a6bc5b957: the page bar on /disputes/:id read "Disputes overview",
// the name of the Disputes menu row, on a single dispute. It names the page
// you are on, from the route's handle when the menu has no row for it. Seen
// failing first (it read "Disputes overview").

const loaderData = {
  accountName: "Alpha",
  accounts: [],
  activeAccountId: "acct_a",
  email: "owner@alpha.test",
  isAdmin: false,
  isDemo: false,
  demoSignedIn: false,
  theme: "light",
  nav: { activeProductKey: "disputes", isPlatformPage: false, intelligenceEntitled: true },
  userName: "Owner",
  readAt: 0,
};

function pageBar(path: string): string | null {
  const Stub = createRoutesStub([
    {
      id: "app-shell",
      path: "/",
      Component: () => createElement(AppLayout, { loaderData } as never),
      children: [
        { path: "disputes/dashboard", Component: () => null },
        { path: "disputes/:id", handle: disputeDetailHandle, Component: () => null },
      ],
    },
  ] as never);
  const html = renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [path],
      hydrationData: { loaderData: { "app-shell": loaderData } },
    } as never),
  );
  return /class="fh-app-page-name">([^<]*)</.exec(html)?.[1] ?? null;
}

describe("the app shell's page bar names the page you are on", () => {
  it("names a single dispute, not the Disputes overview it sits under", () => {
    expect(pageBar("/disputes/dsp_1")).toBe("Dispute detail");
    expect(pageBar("/disputes/dashboard")).toBe("Disputes overview");
  });
});
