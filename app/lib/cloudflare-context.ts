import { createContext } from "react-router";

export interface CloudflareContext {
  env: Env;
  ctx: ExecutionContext;
  /** Per-request CSP nonce (workers/app.ts, site-runtime's generateNonce), threaded to
   *  root.tsx's loader so <Scripts>/<ScrollRestoration> can carry the exact
   *  value applySecurityHeaders puts in the Content-Security-Policy header.
   *  Undefined in the Renderer, so a stored page's loader data holds none. */
  nonce: string | undefined;
  /** Renderer only: the nonce a stored page is rendered with, on React
   *  Router's own scripts; the gateway renews it per reader (renewNonce). */
  storedNonce?: string;
}

export const cloudflareContext = createContext<CloudflareContext>();
