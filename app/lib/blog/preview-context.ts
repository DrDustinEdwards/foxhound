import { createContext } from "react-router";

import type { BlogPost } from "./queries.server";

/** Set only for a Carrel preview (workers/app.ts, the adapter's renderPage): the row built from the submitted source,
 *  which /blog/<slug> renders in place of the stored one. Never set on a request from outside. A null default, so a
 *  request that never sets it reads null rather than throwing. */
export const blogPreviewContext = createContext<BlogPost | null>(null);
