// FOXHOUND'S OWN INDEXNOW KEY (job_b0b24df12155, row F20).
//
// IndexNow (Bing, Yandex and the other engines that share api.indexnow.org)
// proves a site owns the URLs it submits by fetching a key file at the root:
// https://foxhoundapp.com/<key>.txt, whose body is the key. The key is PUBLIC
// by the protocol's design (anyone can fetch that file), so it is a committed
// constant, not a secret or an env var.
//
// A NEW KEY, NOT RECOVA'S (Dustin, Q15, 2026-10-14, "new key"). Recova serves
// a guessable, Recova-branded key from public/recova2026indexnow.txt; this one
// is 16 random bytes in hex from node's crypto.randomBytes, which sits inside
// IndexNow's rule of 8 to 128 characters of a-z, A-Z, 0-9 and "-".
//
// Kept apart from indexnow.server.ts because app/routes.ts imports it to name
// the route, and the route config should not pull in the submit path.

export const INDEXNOW_KEY = "e9244b5b7fea38f9566fdad541569627";

/** Where the key file is served: the site root, named after the key. */
export const INDEXNOW_KEY_PATH = `/${INDEXNOW_KEY}.txt`;
