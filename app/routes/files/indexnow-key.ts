import { INDEXNOW_KEY } from "~/lib/seo/indexnow-key";

// /<key>.txt, the IndexNow key file. Its body is exactly the
// key with no trailing newline, as Recova's public/recova2026indexnow.txt is;
// IndexNow compares the body with the key in each submission and rejects the
// submission silently when they differ.
//
// NO CACHING DIRECTIVE IS SET HERE, as in security-txt.ts: the path is listed
// in cache-policy's FILES_EXACT, so the one choke point in workers/app.ts sets
// it, and cache-policy.test.ts's PLANT 7 refuses a route that sets its own.
export function loader() {
  return new Response(INDEXNOW_KEY, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
