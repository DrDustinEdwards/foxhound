import { createContext } from "react-router";

/** Renderer only: the nonce a stored page is rendered with, on React Router's own scripts; the gateway renews it per
 *  reader (renewNonce). Kept apart from site-runtime's cspNonceContext so a stored page's loader data holds none. */
export const storedNonceContext = createContext<string | undefined>();
