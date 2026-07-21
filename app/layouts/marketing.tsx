import { Outlet } from "react-router";

import { Footer } from "~/components/footer";
import { Header } from "~/components/header";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getSession } from "~/lib/auth/session";
import { getThemeFromRequest } from "~/lib/theme.server";

import type { Route } from "./+types/marketing";

// Session check only (no membership/account resolution): task Part 2 rule 4
// wants authenticated visitors on marketing pages to see their app cluster
// instead of Sign in, but marketing pages should stay cheap, so this stops
// at "is there a session" rather than pulling the full nav context that
// app-shell.tsx resolves for the authenticated app.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  return { isAuthenticated: Boolean(session), theme: getThemeFromRequest(request) };
}

export default function MarketingLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <Header isAuthenticated={loaderData.isAuthenticated} theme={loaderData.theme} />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
