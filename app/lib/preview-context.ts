import { previewContext } from "@dustinedwards/site-runtime/context";

import type { BlogPost } from "~/lib/blog/queries.server";

// Carrel's preview of a post (app/lib/carrel/adapter.server.ts): set only on the in-process render the preview makes
// (workers/app.ts), never on a reader's request, so /blog/<slug> shows the draft in place of the stored post.
export const draftPostContext = previewContext<BlogPost>();
