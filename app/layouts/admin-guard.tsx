import { Outlet } from "react-router";

import { adminOnlyMiddleware } from "~/lib/auth/guards";

import type { Route } from "./+types/admin-guard";

// Pathless layout that carries ONLY the admin-role guard (ROUTES.md: admin
// "reuses the app shell, no distinct admin shell"). It renders its children
// unchanged; the middleware 404s non-admins before any admin loader runs.
export const middleware: Route.MiddlewareFunction[] = [adminOnlyMiddleware];

export default function AdminGuard() {
  return <Outlet />;
}
