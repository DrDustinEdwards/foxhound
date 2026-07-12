import { withSentry } from "@sentry/cloudflare";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";

// Durable Objects exported from the worker entry so wrangler can bind them.
export { MoneyWriteDurableObject } from "./money-writer";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default withSentry<Env>(
  (env) => (env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, tracesSampleRate: 1 } : undefined),
  {
    fetch(request, env, ctx) {
      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx });
      return requestHandler(request, context);
    },
  } satisfies ExportedHandler<Env>,
);
