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
    route("audit", "./routes/audit.tsx"),
    ...prefix("blog", [
      index("./routes/blog/index.tsx"),
      route("tag/:tag", "./routes/blog/tag.tsx"),
      route(":slug", "./routes/blog/post.tsx"),
    ]),
    ...prefix("docs", [
      index("./routes/docs/index.tsx"),
      route(":slug", "./routes/docs/page.tsx"),
    ]),
    route("demos", "./routes/demos.tsx"),
    route("privacy", "./routes/privacy.tsx"),
    route("terms", "./routes/terms.tsx"),

    // Auth (marketing shell per DESIGN.md: "no visual seam at login")
    route("login", "./routes/auth/login.tsx"),
    route("signup", "./routes/auth/signup.tsx"),
    route("forgot-password", "./routes/auth/forgot-password.tsx"),
    route("reset-password", "./routes/auth/reset-password.tsx"),
    route("connect", "./routes/auth/connect.tsx"),
    route("connect/callback", "./routes/auth/connect-callback.ts"),
    route("invite/:token", "./routes/auth/invite.tsx"),

    // Google OAuth start (POST): builds the provider URL + CSRF state cookie.
    // The callback is the resource route auth/google/callback below.
    route("auth/google", "./routes/auth/google-start.ts"),
  ]),

  layout("./layouts/app-shell.tsx", [
    route("dashboard", "./routes/app/dashboard.tsx"),
    ...prefix("recovery", [
      index("./routes/app/recovery/index.tsx"),
      ...prefix("payments", [
        index("./routes/app/recovery/payments/index.tsx"),
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
      route("customers/:id", "./routes/app/intelligence/customer.tsx"),
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

  // Public utility (unauthenticated, no shell)
  route("u/:token", "./routes/utility/unsubscribe.tsx"),
  route("p/:token", "./routes/utility/card-update.tsx"),
  route("e/o/:token", "./routes/utility/engagement-open.ts"),
  route("e/c/:token", "./routes/utility/engagement-click.ts"),

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

  // Logout (action-only resource route; clears the session, redirects to /login)
  route("logout", "./routes/auth/logout.ts"),
] satisfies RouteConfig;
