import { useLocation, useRouteLoaderData, useSubmit } from "react-router";
import { SiteHeader, type HeaderSection, type HeaderSwitcher } from "capsomer/react/site-header";

import { businessSwitcher, type SwitcherAccount } from "./nav/account-switcher";
import { headerLogo, merchantAccountMenu, renderHeaderLink, THEME_PREF_KEY, useThemeMemory } from "./site-header";
import { MARKETING_PILL_ITEMS } from "~/lib/nav/manifest";
import { DEFAULT_THEME, type Theme } from "~/lib/theme";
import type { loader as rootLoader } from "~/root";

export const NAV_LINKS = [
  { to: "/products", label: "Products" },
  { to: "/pricing", label: "Pricing" },
  { to: "/demos", label: "Demos" },
  { to: "/features", label: "Features" },
  { to: "/docs", label: "Docs" },
  { to: "/blog", label: "Blog" },
];

// The public site's header, on Capsomer's site header (capsomer 0.9.0;
// docs/design/design-site-header.md in capsomer). Dustin's answers of
// 2026-10-13 are approved differences from legacy, recorded in
// parity/APPROVED-DIFFERENCES.md: teal on the dark band in place of the old gold accent, the
// business switcher on the left as a square tile before the product switcher,
// the avatar menu last in place of the gear, one icon button for the theme,
// 56px and sticky, and the phone's one row with everything else in a sheet.
//
// What legacy fixed and this keeps: the band is Foxhound's chrome, dark in both
// modes, full width with 24px sides; the wordmark in DM Mono links home; the
// section links sit on the right, before a thin divider, with an underline on
// the current one and legacy's weight 500; Free audit is the one button for a
// visitor who is signed out.
//
// Signed out: Sign in holds the account's place, last, as a text link (an icon
// on a phone). Signed in: the business switcher and the product switcher after
// the wordmark, and the avatar menu last.
export function Header({
  isAuthenticated,
  theme,
  intelligenceEntitled = false,
  isAdmin = false,
  accountLabel = "",
  hasAccount = false,
  accounts = [],
  activeAccountId = null,
  userName = null,
  email = "",
  skipTo,
}: {
  isAuthenticated: boolean;
  /** The layout's resolved theme. Left out on a page with no loader of its
   *  own for it, which then takes the root's (the theme <html> was drawn in). */
  theme?: Theme;
  // Optional: the two standalone public-utility routes outside the
  // marketing layout (card-update.tsx, unsubscribe.tsx) always render
  // Header with isAuthenticated=false and have no session context to
  // resolve these from.
  intelligenceEntitled?: boolean;
  isAdmin?: boolean;
  /** The business you are acting as, the label over its rows in the avatar
   *  menu. */
  accountLabel?: string;
  /** Legacy gates Billing on this: an accountless visitor is redirected to
   *  /connect, so Billing would be a dead row. */
  hasAccount?: boolean;
  /** Every account the visitor actively holds, for the switcher (ruling 326
   *  phase (e)). Empty for an anonymous visitor and for the two standalone
   *  public-utility routes that render this header with no session. */
  accounts?: SwitcherAccount[];
  activeAccountId?: string | null;
  userName?: string | null;
  email?: string;
  /** The page's main region, for the skip link (first in the tab order). */
  skipTo?: string;
}) {
  const { pathname } = useLocation();
  const submit = useSubmit();
  const rootTheme = useRouteLoaderData<typeof rootLoader>("root")?.theme;
  useThemeMemory(theme ?? rootTheme ?? DEFAULT_THEME, isAuthenticated ? "account" : "cookie");

  const sections: HeaderSection[] = NAV_LINKS.map((item) => ({
    id: item.to,
    label: item.label,
    href: item.to,
    current: pathname === item.to || pathname.startsWith(`${item.to}/`),
  }));

  // LEGACY'S RENDER RULE for the business switcher (components/SiteNavClient.tsx):
  // shown from ONE account, hidden only when the visitor has none.
  const business = isAuthenticated && accounts.length > 0 ? businessSwitcher(accounts, activeAccountId) : null;
  // The product switcher, legacy's pill: marketing pages track no active
  // product, so it reads "Home", and it lists legacy's Console, Audit,
  // Recovery, Disputes, Intelligence (gated as in the app).
  const products: HeaderSwitcher = {
    id: "products",
    label: "Home",
    name: "Products: Home",
    sheetLabel: "Products",
    groups: [
      {
        label: "Products",
        links: MARKETING_PILL_ITEMS.filter((i) => !i.requiresIntelligenceEntitlement || intelligenceEntitled).map(
          (i) => ({ id: i.to, label: i.label, href: i.to }),
        ),
      },
    ],
  };
  const switchers = isAuthenticated ? [...(business ? [business] : []), products] : [];

  return (
    <div className="fh-cap fh-site-header" data-family="teal">
      <SiteHeader
        logo={headerLogo("/")}
        links="right"
        sections={sections}
        switchers={switchers}
        extras={isAuthenticated ? [] : [{ id: "audit", label: "Free audit", kind: "button", href: "/audit" }]}
        themePrefKey={THEME_PREF_KEY}
        account={
          isAuthenticated
            ? merchantAccountMenu({
                name: userName,
                email,
                businessName: hasAccount ? accountLabel || null : null,
                hasAccount,
                isAdmin,
                pathname,
                onSignOut: () => void submit(null, { method: "post", action: "/logout" }),
              })
            : undefined
        }
        signIn={isAuthenticated ? undefined : { href: "/login" }}
        skipTo={skipTo}
        sheetTitle="Foxhound menu"
        renderLink={renderHeaderLink}
      />
    </div>
  );
}
