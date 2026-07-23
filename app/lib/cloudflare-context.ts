import { createContext } from "react-router";

export interface CloudflareContext {
  env: Env;
  ctx: ExecutionContext;
  /** Per-request CSP nonce (workers/app.ts, generateNonce), threaded to
   *  root.tsx's loader so <Scripts>/<ScrollRestoration> can carry the exact
   *  value applySecurityHeaders puts in the Content-Security-Policy header. */
  nonce: string;
}

export const cloudflareContext = createContext<CloudflareContext>();
