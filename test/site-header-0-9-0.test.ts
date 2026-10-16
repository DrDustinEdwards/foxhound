import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { Header } from "~/components/header";
import { BUSINESS_ROW_LABELS, merchantAccountMenu, personInitials } from "~/components/site-header";

// Capsomer 0.9.0's site header on Foxhound (job_da34077992a5; capsomer
// docs/design/design-site-header.md, Dustin's answers of 2026-10-13, recorded as
// approved differences in parity/APPROVED-DIFFERENCES.md). These pin the
// header's contract on the RENDERED markup where a render is possible (the
// public header) and on the layouts' source where the shell needs a route
// tree: the order of the slots, the avatar menu that replaced the gear, teal on
// the band in place of amber, and the owner and user variants.

const ACCOUNTS = [
  { id: "acct_a", name: "Acme Supply Co.", stripeUserId: null },
  { id: "acct_b", name: "Northwind Goods", stripeUserId: null },
];

function render(props: Parameters<typeof Header>[0], path = "/pricing"): string {
  const router = createMemoryRouter([{ path: "*", element: createElement(Header, props) }], {
    initialEntries: [path],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Where each marker first appears, so the order of the slots can be read. */
function at(html: string, marker: string): number {
  const i = html.indexOf(marker);
  expect(i, `${marker} is in the header`).toBeGreaterThan(-1);
  return i;
}

const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("signed out: logo, links on the right, Free audit, theme, Sign in last", () => {
  const html = render({ isAuthenticated: false, theme: "dark" });

  it("puts the slots in the design's order", () => {
    const order = [
      'class="cap-site-header-logo"',
      'class="cap-site-header-sections"',
      'class="cap-site-header-cta"',
      'data-cap="theme-switch"',
      'class="cap-site-header-signin"',
      'class="cap-site-header-icon cap-site-header-menu"',
    ].map((m) => at(html, m));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps the section links on the right, the current one marked", () => {
    expect(html).toContain('data-links="right"');
    expect(html).toMatch(/<a[^>]*class="cap-site-header-link"[^>]*aria-current="page"[^>]*>Pricing<\/a>/);
  });

  it("has Free audit as the one button, Sign in in the account's place, and no switcher or avatar", () => {
    expect(html).toMatch(/class="cap-site-header-cta"[^>]*>Free audit</);
    expect(html).toMatch(/href="\/login"/);
    expect(html).not.toContain("cap-site-header-switcher");
    expect(html).not.toContain("cap-site-header-avatar");
  });

  it("draws the wordmark with the x in its own (teal) span, in Foxhound's dark band", () => {
    expect(html).toMatch(/class="fh-wordmark"[^>]*>fo<span class="fh-wordmark-x">x<\/span>hound/);
    expect(html).toContain('data-family="teal"');
    expect(html).toContain('class="fh-cap fh-site-header"');
  });
});

describe("signed in: the business tile and the product on the left, the avatar menu last", () => {
  const props = {
    isAuthenticated: true,
    theme: "light" as const,
    accounts: ACCOUNTS,
    activeAccountId: "acct_a",
    accountLabel: "Acme Supply Co.",
    hasAccount: true,
    isAdmin: true,
    userName: "Sam Rivera",
    email: "sam@example.com",
  };
  const html = render(props, "/settings/team");

  it("puts the business, then a slash, then the product, after the logo and before the links", () => {
    const order = [
      'class="cap-site-header-logo"',
      'class="cap-site-header-switch-tile" aria-hidden="true">A</span><span>Acme Supply Co.</span>',
      'class="cap-site-header-sep"',
      "<span>Home</span>",
      'class="cap-site-header-sections"',
      'data-cap="theme-switch"',
      "cap-site-header-avatar",
    ].map((m) => at(html, m));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("has no gear and no Free audit once signed in", () => {
    expect(html).not.toContain('aria-label="Open menu"');
    expect(html).not.toContain("cap-site-header-cta");
    expect(html).not.toContain("cap-site-header-signin");
  });

  it("the avatar menu: you, the business's rows under its name, Help, Admin, Sign out last", () => {
    const panel = html.slice(html.indexOf('class="cap-site-header-who"'));
    const rows = ["Sam Rivera", "sam@example.com", "Acme Supply Co.", ...BUSINESS_ROW_LABELS, "Help", "Admin", "Sign out"];
    const positions = rows.map((r) => at(panel, `>${r}<`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The page you are on is marked in the menu.
    expect(panel).toMatch(/href="\/settings\/team"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings\/team"/);
  });
});

describe("the avatar menu's rows", () => {
  const base = {
    name: "Sam Rivera",
    email: "sam@example.com",
    businessName: "Acme Supply Co.",
    isAdmin: false,
    pathname: "/dashboard",
    onSignOut: () => {},
  };

  it("holds exactly the design's rows, on the routes the gear linked to", () => {
    const menu = merchantAccountMenu({ ...base, hasAccount: true });
    expect(menu.groups?.[0]?.label).toBe("Acme Supply Co.");
    expect(menu.groups?.[0]?.links.map((l) => [l.label, l.href])).toEqual([
      ["Settings", "/settings"],
      ["Billing", "/billing"],
      ["Team", "/settings/team"],
      ["Audit settings", "/settings/audit"],
      ["Audit history", "/audit/dashboard"],
      ["Email settings", "/settings/email"],
      ["Alerts", "/settings/alerts"],
      ["API keys", "/settings/api-keys"],
      ["Brand voice", "/settings/brand-voice"],
    ]);
    expect(menu.groups?.[1]?.links.map((l) => l.label)).toEqual(["Help"]);
    expect(menu.onSignOut).toBeTypeOf("function");
  });

  it("drops Billing without an account (legacy's gate) and adds Admin for an admin", () => {
    const menu = merchantAccountMenu({ ...base, hasAccount: false, isAdmin: true });
    expect(menu.groups?.[0]?.links.map((l) => l.label)).not.toContain("Billing");
    expect(menu.groups?.[1]?.links.map((l) => l.label)).toEqual(["Help", "Admin"]);
  });

  it("puts initials on the avatar, a circle for you", () => {
    expect(personInitials("Sam Rivera", "sam@example.com")).toBe("SR");
    expect(personInitials("Cher", "c@example.com")).toBe("CH");
    expect(personInitials(null, "dustin@example.com")).toBe("D");
  });
});

describe("teal on the band, amber gone from the header", () => {
  const CSS = readFileSync("app/app.css", "utf8");
  const band = CSS.slice(CSS.indexOf(".fh-cap .cap-site-header,"), CSS.indexOf("/* Foxhound's own focus rule"));

  it("defines the band's teal pair once, in the token file", () => {
    expect(CSS).toMatch(/--header-teal:\s*#249398;/);
    expect(CSS).toMatch(/--header-teal-fg:\s*#070f0f;/);
  });

  it("puts teal on every accent the band draws, on Foxhound's chrome", () => {
    for (const token of ["--header-accent", "--header-cta", "--header-avatar", "--ring"]) {
      expect(band).toMatch(new RegExp(`${token}:\\s*var\\(--header-teal\\);`));
    }
    expect(band).toMatch(/--header-cta-fg:\s*var\(--header-teal-fg\);/);
    expect(band).toMatch(/--header-bg:\s*var\(--chrome\);/);
    expect(band).not.toMatch(/amber/);
  });

  it("takes the page's teal from Capsomer's teal family: #01585c light, #97c8cb dark", () => {
    const family = readFileSync("node_modules/capsomer/tokens/family-teal.css", "utf8");
    expect(family).toMatch(/\[data-family="teal"\] \{[^}]*--accent-text: #01585c;/);
    expect(family).toMatch(/\[data-cap-theme="dark"\]\[data-family="teal"\] \{[^}]*--accent-text: #97c8cb;/);
  });

  it("no header source names amber", () => {
    for (const file of ["app/components/header.tsx", "app/components/site-header.tsx", "app/components/nav/account-switcher.tsx"]) {
      expect(code(file), file).not.toMatch(/amber/);
    }
  });
});

describe("your admin is the owner variant, the merchant app the user variant", () => {
  const ADMIN = code("app/layouts/admin-shell.tsx");
  const APP = code("app/layouts/app-shell.tsx");

  it("the admin keeps the family strip with Foxhound marked", () => {
    expect(ADMIN).toContain('variant="owner"');
    expect(ADMIN).toContain('app="foxhound"');
    expect(ADMIN).toContain('viewSite="/"');
    expect(ADMIN).toContain('window.location.assign("/cdn-cgi/access/logout")');
    // The theme is the header's button, not a switch in the page bar.
    expect(ADMIN).not.toContain("ThemeSwitch");
  });

  it("the merchant app has no strip, the business and product switchers, and at most five tabs", () => {
    expect(APP).toContain('variant="user"');
    expect(APP).not.toMatch(/\bapp="/);
    expect(APP).toContain("switchers={business ? [business, products] : [products]}");
    expect(APP).toContain("tabLinks.length > 5");
    // The gear is gone from both.
    expect(APP).not.toContain("GearMenu");
    expect(code("app/components/header.tsx")).not.toContain("GearMenu");
  });
});
