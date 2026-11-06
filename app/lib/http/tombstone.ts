import { d1SiteApiStore } from "@dustinedwards/site-api/store";

/**
 * A post Carrel deleted or trashed leaves a tombstone (site-api 0.22.0, gone_paths, migration 0074), and its address
 * answers 410 Gone instead of 404, so a search engine drops it rather than retrying it (RFC 9110, section 15.5.11).
 * The reader sees the same not-found page: only the status changes, it is never stored, and it is kept out of the
 * index. Asked only on a 404, so a page that answers costs no query; isGone answers false when the store cannot be read.
 */
export async function tombstoned(response: Response, pathname: string, db: Parameters<typeof d1SiteApiStore>[0]): Promise<Response> {
  if (response.status !== 404 || !(await d1SiteApiStore(db).isGone(pathname))) return response;
  const gone = new Response(response.body, { status: 410, statusText: "Gone", headers: response.headers });
  gone.headers.set("Cache-Control", "no-store");
  gone.headers.set("X-Robots-Tag", "noindex");
  return gone;
}
