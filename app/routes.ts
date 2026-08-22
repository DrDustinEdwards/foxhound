import {
  type RouteConfig,
  index,
  layout,
  prefix,
  route,
} from "@react-router/dev/routes";

export default [
  layout("./layouts/marketing.tsx", [
    index("./routes/home.tsx"),
    route("pricing", "./routes/pricing.tsx"),
    ...prefix("products", [
      index("./routes/products/index.tsx"),
      route("audit", "./routes/products/audit.tsx"),
      route("recovery", "./routes/products/recovery.tsx"),
      route("disputes", "./routes/products/disputes.tsx"),
      route("intelligence", "./routes/products/intelligence.tsx"),
    ]),
    ...prefix("decline-codes", [
      index("./routes/decline-codes/index.tsx"),
      route(":code", "./routes/decline-codes/code.tsx"),
    ]),
    ...prefix("compare", [
      index("./routes/compare/index.tsx"),
      route(":competitor", "./routes/compare/competitor.tsx"),
    ]),
    route("audit", "./routes/audit.tsx"),
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

    // Auth (marketing shell per DESIGN.md: "no visual seam at login")
    route("login", "./routes/auth/login.tsx"),
    route("signup", "./routes/auth/signup.tsx"),
    route("forgot-password", "./routes/auth/forgot-password.tsx"),
    route("reset-password", "./routes/auth/reset-password.tsx"),
    route("connect", "./routes/auth/connect.tsx"),
    route("connect/callback", "./routes/auth/connect-callback.ts"),
    // The switcher's "+ Add account" (ruling 326 phase (e), first half of (d)).
    // Legacy mounts this at /api/stripe/connect-additional; the path here
    // mirrors Foxhound's own connect routes instead.
    route("connect/additional", "./routes/auth/connect-additional.ts"),
    route("invite/:token", "./routes/auth/invite.tsx"),

    // Google OAuth start (POST): builds the provider URL + CSRF state cookie.
    // The callback is the resource route auth/google/callback below.
    route("auth/google", "./routes/auth/google-start.ts"),
  ]),

  layout("./layouts/app-shell.tsx", { id: "app-shell" }, [
    route("dashboard", "./routes/app/dashboard.tsx"),
    ...prefix("recovery", [
      index("./routes/app/recovery/index.tsx"),
      ...prefix("payments", [
        index("./routes/app/recovery/payments/index.tsx"),
        route("export.csv", "./routes/app/recovery/payments/export.ts"),
        route(":id", "./routes/app/recovery/payments/detail.tsx"),
      ]),
      route("sequences", "./routes/app/recovery/sequences.tsx"),
      route("winback", "./routes/app/recovery/winback.tsx"),
      route("expiring-cards", "./routes/app/recovery/expiring-cards.tsx"),
    ]),
    ...prefix("disputes", [
      index("./routes/app/disputes/index.tsx"),
      route(":id", "./routes/app/disputes/detail.tsx"),
    ]),
    ...prefix("intelligence", [
      index("./routes/app/intelligence/index.tsx"),
      route("customers", "./routes/app/intelligence/customers.tsx"),
      route("customers/:id", "./routes/app/intelligence/customer.tsx"),
      route("churn", "./routes/app/intelligence/churn.tsx"),
      route("alerts", "./routes/app/intelligence/alerts.tsx"),
      route("reports", "./routes/app/intelligence/reports.tsx"),
    ]),
    ...prefix("billing", [
      index("./routes/app/billing/index.tsx"),
      route("invoices/:id", "./routes/app/billing/invoice.tsx"),
    ]),
    ...prefix("settings", [
      index("./routes/app/settings/index.tsx"),
      route("team", "./routes/app/settings/team.tsx"),
      route("audit", "./routes/app/settings/audit.tsx"),
      route("email", "./routes/app/settings/email.tsx"),
      route("alerts", "./routes/app/settings/alerts.tsx"),
    ]),
    route("help", "./routes/app/help.tsx"),
    route("welcome", "./routes/app/welcome.tsx"),

    // Admin (role-guarded; reuses the app shell, no distinct admin shell in
    // ROUTES.md). The pathless admin-guard layout adds the admin-role middleware
    // (404 for non-admins) without changing the URL structure or the shell.
    layout("./layouts/admin-guard.tsx", [
      ...prefix("admin", [
        index("./routes/admin/index.tsx"),
        ...prefix("merchants", [
          index("./routes/admin/merchants/index.tsx"),
          route(":id", "./routes/admin/merchants/detail.tsx"),
        ]),
        route("users", "./routes/admin/users.tsx"),
        route("operations", "./routes/admin/operations.tsx"),
        route("brake", "./routes/admin/brake.tsx"),
        route("crons", "./routes/admin/crons.tsx"),
        route("webhooks", "./routes/admin/webhooks.tsx"),
        ...prefix("blog", [
          index("./routes/admin/blog/index.tsx"),
          route(":id", "./routes/admin/blog/detail.tsx"),
        ]),
        route("social", "./routes/admin/social.tsx"),
        route("audit-log", "./routes/admin/audit-log.tsx"),
      ]),
    ]),
  ]),

  // Demo exit (clears the demo cookie; unauthenticated, no shell)
  route("demo/exit", "./routes/demo/exit.ts"),

  // Public utility (unauthenticated, no shell)
  route("u/:token", "./routes/utility/unsubscribe.tsx"),
  route("p/:token", "./routes/utility/card-update.tsx"),
  route("e/o/:token", "./routes/utility/engagement-open.ts"),
  route("e/c/:token", "./routes/utility/engagement-click.ts"),

  // Webhooks (resource routes, no shell; POST-only, signature-verified)
  route("webhooks/stripe", "./routes/webhooks/stripe.ts"),
  route("webhooks/stripe-platform", "./routes/webhooks/stripe-platform.ts"),

  // Files (resource routes, no shell)
  route("sitemap.xml", "./routes/files/sitemap.ts"),
  route("robots.txt", "./routes/files/robots.ts"),
  route("llms.txt", "./routes/files/llms.ts"),
  route("llms-full.txt", "./routes/files/llms-full.ts"),
  route("feed.rss", "./routes/files/feed.ts"),
  route("og/:params", "./routes/files/og.ts"),

  // Auth callback (resource route, no shell)
  route("auth/google/callback", "./routes/auth/google-callback.ts"),

  // Better Auth HTTP surface (sign-in/up/out, verify, reset, OAuth callbacks).
  route("api/auth/*", "./routes/api/auth.ts"),

  // Theme persistence (ruling 59). Action-only resource route; the read side
  // is resolveThemeForRequest in lib/theme.server.ts.
  route("api/theme", "./routes/api/theme.ts"),

  // Active-account switch (ruling 326 phase (b)). Action-only resource route at
  // legacy's own path, which components/SiteNav.tsx passes to the switcher as
  // switchAccountUrl. The switcher itself is phase (e).
  route("api/account/switch", "./routes/api/account-switch.ts"),

  // Logout (action-only resource route; clears the session, redirects to /login)
  route("logout", "./routes/auth/logout.ts"),
] satisfies RouteConfig;
