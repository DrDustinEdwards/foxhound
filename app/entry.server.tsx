// The network's React Router server entry (site-runtime ./react-entry): the request's nonce on React's streamed
// scripts, on ServerRouter and in ./nonce's NonceContext; bots wait for all content. The shared Worker counts 404s
// (page_404_daily, read by the admin API's /health top_404s_7d), a .data navigation's as its page.
import { serverErrorHandler } from "@dustinedwards/site-runtime/log";

import { TOKEN_PATH } from "~/lib/errors/token-routes";

export { default, streamTimeout } from "@dustinedwards/site-runtime/react-entry";

// A route error is one scrubbed server_error line, a 404 none; a token page's token is cut from the path. React Router
// reads the export as handleError; it is ./log's handler made with Foxhound's token routes, not a copy of it.
const cutTokenRoutes = serverErrorHandler({ tokenPath: TOKEN_PATH });
export { cutTokenRoutes as handleError };
