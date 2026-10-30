import { createContext } from "react-router";

export interface CloudflareContext {
  env: Env;
  ctx: ExecutionContext;
  /** Per-request CSP nonce (workers/app.ts, site-runtime's generateNonce), threaded to
   *  root.tsx's loader so <Scripts>/<ScrollRestoration> can carry the exact
   *  value applySecurityHeaders puts in the Content-Security-Policy header.
   *  Undefined in the Renderer: a page the edge stores carries no nonce and is
   *  trusted by its scripts' hashes instead (applyHashedSecurityHeaders). */
  nonce: string | undefined;
}

export const cloudflareContext = createContext<CloudflareContext>();
