import { Form, Link, Outlet } from "react-router";

import { Wordmark } from "~/components/wordmark";
import { appShellMiddleware } from "~/lib/auth/guards";
import { authContext } from "~/lib/auth/context";

import type { Route } from "./+types/app-shell";

// Server guard for the entire authenticated tree (session + account required).
export const middleware: Route.MiddlewareFunction[] = [appShellMiddleware];

// Header display data, read from the context the guard populated.
export function loader({ context }: Route.LoaderArgs) {
  const auth = context.get(authContext);
  return {
    accountName: auth.membership.accountName,
    email: auth.email,
    isAdmin: auth.isAdmin,
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/dashboard" aria-label="Foxhound dashboard">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-4 text-label text-text-tertiary">
            {loaderData.isAdmin ? (
              <Link to="/admin" className="hover:text-text">
                Admin
              </Link>
            ) : null}
            <span>{loaderData.accountName ?? loaderData.email}</span>
            <Form method="post" action="/logout">
              <button type="submit" className="text-text-tertiary hover:text-text">
                Sign out
              </button>
            </Form>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
