import {
  type RouteConfig,
  index,
  layout,
  prefix,
  route,
} from "@react-router/dev/routes";

import { INDEXNOW_KEY_PATH } from "./lib/seo/indexnow-key";

export default [
  layout("./layouts/marketing.tsx", [
    index("./routes/home.tsx"),
    route("pricing", "./routes/pricing.tsx"),
    // Recova's paths: the hub is /products and each
    // product's page is /product/<name>, singular, as in Recova's
    // app/(marketing)/product/*. The old /products/<name> spokes were in the
    // sitemap, so each answers one 301 to its new path; any other name is a 404.
    route("products", "./routes/products/index.tsx"),
    ...prefix("product", [
      route("audit", "./routes/products/audit.tsx"),
      route("recovery", "./routes/products/recovery.tsx"),
      route("disputes", "./routes/products/disputes.tsx"),
      route("intelligence", "./routes/products/intelligence.tsx"),
    ]),
    route("products/:spoke", "./routes/products/spoke-redirect.ts"),
    ...prefix("decline-codes", [
      index("./routes/decline-codes/index.tsx"),
      route(":code", "./routes/decline-codes/code.tsx"),
    ]),
    ...prefix("compare", [
      index("./routes/compare/index.tsx"),
      route(":competitor", "./routes/compare/competitor.tsx"),
    ]),
    route("audit", "./routes/audit.tsx"),
    // The anonymous audit pair and its live results page (phase (f), 362
    // ruling 1). These sit under the MARKETING shell, not the app shell,
    // because every one of them serves a visitor with no Foxhound account:
    // /audit/connect is the consent screen, /audit/callback is the OAuth
    // return, and /audit/results renders a run held together by a five-minute
    // cookie. Legacy mounts all three under its own marketing chrome for the
    // same reason. The two AUTHENTICATED audit surfaces (/audit/dashboard and
    // /audit/results/:id) stay under the app shell where they were built.
    route("audit/connect", "./routes/audit/connect.tsx"),
    route("audit/callback", "./routes/audit/callback.ts"),
    route("audit/results", "./routes/audit/results.tsx"),
    // J43: the signed-in history moved to Recova's /audit/dashboard (below, in
    // the app shell). The old path answers one 301 to it.
    route("audit/history", "./routes/audit/history-redirect.ts"),
    // J63: a saved run moved to Recova's /audit/results/:id (below, in the app
    // shell). The old path, linked from monthly emails already sent, answers
    // one 301 to it.
    route("audit/runs/:id", "./routes/audit/runs-redirect.ts"),
    route("marketing/generate-email-sample", "./routes/marketing/generate-email-sample.ts"),
    ...prefix("blog", [
      index("./routes/blog/index.tsx"),
      route("archive", "./routes/blog/archive.tsx"),
      route("tag/:tag", "./routes/blog/tag.tsx"),
      route(":slug", "./routes/blog/post.tsx"),
    ]),
    ...prefix("docs", [
      index("./routes/docs/index.tsx"),
      route(":slug", "./routes/docs/page.tsx"),
    ]),
    ...prefix("demos", [
      index("./routes/demos.tsx"),
      route("dashboard", "./routes/demos/dashboard.ts"),
      route("recovery", "./routes/demos/recovery.ts"),
      route("disputes", "./routes/demos/disputes.ts"),
      route("intelligence", "./routes/demos/intelligence.ts"),
    ]),
    route("features", "./routes/features.tsx"),
    route("about", "./routes/about.tsx"),
    route("privacy", "./routes/privacy.tsx"),
    route("terms", "./routes/terms.tsx"),
    route("security", "./routes/security.tsx"),

    // Stripe connect and invites stay under the site header: Recova mounts
    // them outside its (auth) group.
    route("connect", "./routes/auth/connect.tsx"),
    route("connect/callback", "./routes/auth/connect-callback.ts"),
    // The switcher's "+ Add account" (ruling 326 phase (e), first half of (d)).
    // Legacy mounts this at /api/stripe/connect-additional; the path here
    // mirrors Foxhound's own connect routes instead.
    route("connect/additional", "./routes/auth/connect-additional.ts"),
    route("invite/:token", "./routes/auth/invite.tsx"),

    // Google or Apple start (POST /auth/google, /auth/apple): builds the
    // provider URL + CSRF state cookie. Google's callback is the resource route
    // auth/google/callback below; Apple's is Better Auth's own under api/auth.
    route("auth/:provider", "./routes/auth/social-start.ts"),
  ]),

  // The sign-in pages: Recova's bare auth layout, no site navigation and the
  // footer's auth variant. /passkey is where an
  // emailed sign-in link lands (site-runtime ./sign-in).
  layout("./layouts/auth.tsx", [
    route("login", "./routes/auth/login.tsx"),
    route("signup", "./routes/auth/signup.tsx"),
    route("passkey", "./routes/auth/passkey-offer.tsx"),
  ]),

  // Recova's paths: the console is /console and each
  // product's overview is /<product>/dashboard. Foxhound's former paths
  // (/dashboard, the bare /recovery, /disputes and /intelligence) were never
  // public and are not redirected; Recova has no page at them either.
  layout("./layouts/app-shell.tsx", { id: "app-shell" }, [
    route("console", "./routes/app/dashboard.tsx"),
    ...prefix("recovery", [
      route("dashboard", "./routes/app/recovery/index.tsx"),
      ...prefix("payments", [
        index("./routes/app/recovery/payments/index.tsx"),
        route("export.csv", "./routes/app/recovery/payments/export.ts"),
        route(":id", "./routes/app/recovery/payments/detail.tsx"),
      ]),
      route("sequence", "./routes/app/recovery/sequences.tsx"),
      route("winback", "./routes/app/recovery/winback.tsx"),
      route("expiring-cards", "./routes/app/recovery/expiring-cards.tsx"),
    ]),
    ...prefix("disputes", [
      route("dashboard", "./routes/app/disputes/index.tsx"),
      route(":id", "./routes/app/disputes/detail.tsx"),
      // J07: one merchant evidence file, served after the account check.
      route(":id/files/:fileId", "./routes/app/disputes/file.ts"),
    ]),
    ...prefix("intelligence", [
      route("dashboard", "./routes/app/intelligence/index.tsx"),
      route("customers", "./routes/app/intelligence/customers.tsx"),
      route("customers/:id", "./routes/app/intelligence/customer.tsx"),
      route("recommendations", "./routes/app/intelligence/recommendations.tsx"),
      route("churn", "./routes/app/intelligence/churn.tsx"),
      route("reports", "./routes/app/intelligence/reports.tsx"),
    ]),
    ...prefix("billing", [
      index("./routes/app/billing/index.tsx"),
      route("invoices/:id", "./routes/app/billing/invoice.tsx"),
    ]),
    // S24 and S25: legacy's settings HUB plus a sub-nav layout,
    // replacing Foxhound's stack of inline cards. Every entry below is a link on
    // that hub, in legacy's order.
    layout("./layouts/settings.tsx", [
      ...prefix("settings", [
        index("./routes/app/settings/hub.tsx"),
        route("stripe", "./routes/app/settings/stripe.tsx"),
        route("email", "./routes/app/settings/email.tsx"),
        route("brand-voice", "./routes/app/settings/brand-voice.tsx"),
        route("disputes", "./routes/app/settings/disputes.tsx"),
        route("audit", "./routes/app/settings/audit.tsx"),
        route("notifications", "./routes/app/settings/notifications.tsx"),
        route("team", "./routes/app/settings/team.tsx"),
        route("api-keys", "./routes/app/settings/api-keys.tsx"),
        route("account", "./routes/app/settings/account.tsx"),
      ]),
    ]),
    // The audit's authenticated surfaces. Legacy mounts these at
    // /audit/dashboard and /audit/results/[id] inside its own marketing-chrome
    // layout; Foxhound's /audit is the anonymous estimator under the marketing
    // shell, so these two live under the APP shell where a signed-in merchant's
    // own data belongs. J43 put the history back on Recova's own path,
    // /audit/dashboard, and J63 the stored run on Recova's
    // /audit/results/:id. That sits beside the live /audit/results above
    // without colliding: the router ranks the id segment apart.
    ...prefix("audit", [
      route("dashboard", "./routes/app/audit/dashboard.tsx"),
      route("results/:id", "./routes/app/audit/run.tsx"),
    ]),
    route("help", "./routes/app/help.tsx"),
    route("welcome", "./routes/app/welcome.tsx"),
  ]),

  // Admin: its own layout, Capsomer's AdminShell, behind Cloudflare Access.
  // Not under the app shell: no merchant session, account or
  // demo cookie is involved. admin-shell.tsx's middleware verifies Access's JWT
  // and the ADMIN_EMAIL allowlist (404 otherwise) before any admin loader runs.
  layout("./layouts/admin-shell.tsx", [
    ...prefix("admin", [
      index("./routes/admin/index.tsx"),
      ...prefix("merchants", [
        index("./routes/admin/merchants/index.tsx"),
        // Recova's Paused and Billing exempt lists, at Recova's addresses:
        // filters of the Merchants page, which these modules re-export.
        route("paused", "./routes/admin/merchants/paused.tsx"),
        route("billing-exempt", "./routes/admin/merchants/billing-exempt.tsx"),
        route(":id", "./routes/admin/merchants/detail.tsx"),
      ]),
      route("users", "./routes/admin/users.tsx"),
      route("operations", "./routes/admin/operations.tsx"),
      route("brake", "./routes/admin/brake.tsx"),
      // Recova's Platform group (app/admin/admin-nav.ts): crons, errors,
      // webhooks and the audit log live under /admin/platform. The old Foxhound
      // paths sat behind Access and are not redirected, and Recova's own
      // orphaned /admin/webhooks and /admin/audit-log were declined with "no
      // redirect".
      ...prefix("platform", [
        route("crons", "./routes/admin/crons.tsx"),
        route("errors", "./routes/admin/errors.tsx"),
        route("webhooks", "./routes/admin/webhooks.tsx"),
        route("audit-log", "./routes/admin/audit-log.tsx"),
      ]),
      // No Blog or Social page: Carrel is the blog editor and admin Social.
      // It writes posts through the Carrel site
      // adapter (app/lib/carrel/adapter.server.ts); /blog still reads them.
      route("staged", "./routes/admin/staged.tsx"),
      // "View as merchant" (Recova's Impersonate, read-only): POST starts a
      // 30-minute view and lands in the merchant's app; Stop, linked from the
      // app's banner, ends it. Both behind Access like every /admin route.
      route("view-as", "./routes/admin/view-as.ts"),
      route("view-as/stop", "./routes/admin/view-as-stop.ts"),
    ]),
  ]),

  // The OAuth consent page. No layout: Recova's
  // app/oauth/authorize/page.tsx sits under its bare root layout, one card on
  // the page with no site navigation.
  route("oauth/authorize", "./routes/oauth/authorize.tsx"),

  // Demo exit (clears the demo cookie; unauthenticated, no shell)
  route("demo/exit", "./routes/demo/exit.ts"),

  // Public utility (unauthenticated, no shell)
  route("u/:token", "./routes/utility/unsubscribe.tsx"),
  route("p/:token", "./routes/utility/card-update.tsx"),
  route("e/o/:token", "./routes/utility/engagement-open.ts"),
  route("e/c/:token", "./routes/utility/engagement-click.ts"),
  // The honeypot. Shaped like its siblings on purpose: a
  // scanner that could tell the trap from the real link would not fall in it.
  route("e/h/:token", "./routes/utility/engagement-honeypot.ts"),

  // Webhooks (resource routes, no shell; POST-only, signature-verified)
  route("webhooks/stripe", "./routes/webhooks/stripe.ts"),
  route("webhooks/stripe-platform", "./routes/webhooks/stripe-platform.ts"),

  // Health (unauthenticated JSON; backup age only, no merchant data)
  route("health", "./routes/health.ts"),

  // Files (resource routes, no shell)
  route("sitemap.xml", "./routes/files/sitemap.ts"),
  route("robots.txt", "./routes/files/robots.ts"),
  route("ai.txt", "./routes/files/ai-txt.ts"),
  route("llms.txt", "./routes/files/llms.ts"),
  route("llms-full.txt", "./routes/files/llms-full.ts"),
  route("feed.rss", "./routes/files/feed.ts"),
  route(".well-known/security.txt", "./routes/files/security-txt.ts"),
  // OAuth discovery. Recova's next.config.ts rewrote
  // both paths to one handler because Claude.ai probes both; one module here,
  // so each path needs its own id.
  route(".well-known/oauth-authorization-server", "./routes/files/oauth-metadata.ts", { id: "oauth-metadata" }),
  route(".well-known/openid-configuration", "./routes/files/oauth-metadata.ts", { id: "oauth-metadata-openid" }),
  // RFC 9728 metadata for /mcp, which every /mcp 401 points at, at the
  // bare path and at the /mcp suffix a client may try first.
  route(".well-known/oauth-protected-resource", "./routes/files/oauth-protected-resource.ts", { id: "oauth-protected-resource" }),
  route(".well-known/oauth-protected-resource/mcp", "./routes/files/oauth-protected-resource.ts", { id: "oauth-protected-resource-mcp" }),
  // The IndexNow key file: /<key>.txt at the root, named
  // after Foxhound's own key so the path and the body cannot drift apart.
  route(INDEXNOW_KEY_PATH.slice(1), "./routes/files/indexnow-key.ts"),
  route("og/:params", "./routes/files/og.ts"),
  // Recova's card URL, /og?type=blog&title=...&description=... (ruling 41,
  // row F6). Same module as the path form, so it needs its own id.
  route("og", "./routes/files/og.ts", { id: "og-recova" }),
  // The blog's media library (Carrel uploads): an original, or one size for ?w=.
  route("media/*", "./routes/files/media.ts"),

  // Recova's config-level redirects (J23, ledger row F17), at Recova's own
  // paths. One resource module answers all of them from Recova's table in
  // app/lib/redirects/recova-config-redirects.ts; each path needs its own id
  // because the module is shared.
  route("recovery/audit", "./routes/redirects/recova-config.ts", { id: "recova-redirect-audit" }),
  route("recovery/audit/connect", "./routes/redirects/recova-config.ts", { id: "recova-redirect-audit-connect" }),
  route("recovery/audit/results", "./routes/redirects/recova-config.ts", { id: "recova-redirect-audit-results" }),
  route("user-guides", "./routes/redirects/recova-config.ts", { id: "recova-redirect-user-guides" }),
  route("user-guides/*", "./routes/redirects/recova-config.ts", { id: "recova-redirect-user-guides-splat" }),
  route("sitemap_index.xml", "./routes/redirects/recova-config.ts", { id: "recova-redirect-sitemap-index" }),
  // Pages combined into others (Dustin, 2026-10-29): the old addresses redirect.
  route("settings/alerts", "./routes/redirects/moved-page.ts", { id: "moved-settings-alerts" }),
  route("settings/intelligence", "./routes/redirects/moved-page.ts", { id: "moved-settings-intelligence" }),
  route("settings/features", "./routes/redirects/moved-page.ts", { id: "moved-settings-features" }),
  route("intelligence/alerts", "./routes/redirects/moved-page.ts", { id: "moved-intelligence-alerts" }),
  route("admin/mcps", "./routes/redirects/moved-page.ts", { id: "moved-admin-mcps" }),

  // Auth callback (resource route, no shell)
  route("auth/google/callback", "./routes/auth/google-callback.ts"),

  // Better Auth HTTP surface (sign-in/up/out, verify, reset, OAuth callbacks).
  route("api/auth/*", "./routes/api/auth.ts"),

  // Theme persistence. Action-only resource route; the read side
  // is resolveThemeForRequest in lib/theme.server.ts.
  route("api/theme", "./routes/api/theme.ts"),

  // Active-account switch. Action-only resource route at
  // legacy's own path, which components/SiteNav.tsx passes to the switcher as
  // switchAccountUrl. The switcher itself is phase (e).
  route("api/account/switch", "./routes/api/account-switch.ts"),

  // Demo business switch: legacy's /api/demo/switch-account, which SiteNav.tsx
  // passes to the switcher as switchAccountUrl in the demo. Action-only; it
  // sets which demo business the visitor sees and writes nothing else.
  route("api/demo/switch-account", "./routes/api/demo-switch-account.ts"),

  // The OAuth provider's three endpoints, at Recova's paths. Action-only
  // resource routes; the work is in app/lib/oauth/provider.server.ts.
  route("api/oauth/token", "./routes/api/oauth-token.ts"),
  route("api/oauth/register", "./routes/api/oauth-register.ts"),
  route("api/oauth/revoke", "./routes/api/oauth-revoke.ts"),

  // Content-Security-Policy report sink (J22, F16): the policy's report-uri and
  // report-to name it. Action-only resource route at Recova's own path.
  route("api/csp-report", "./routes/api/csp-report.ts"),

  // Logout (action-only resource route; clears the session, redirects to /login)
  route("logout", "./routes/auth/logout.ts"),
] satisfies RouteConfig;
