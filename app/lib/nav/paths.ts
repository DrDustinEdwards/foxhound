// Nav paths that more than one module has to agree on. Client-safe: no server
// imports, so the switcher component can read it without dragging a .server
// module into the client bundle.

/**
 * Where the switcher's "+ Add account" row goes.
 *
 * Named rather than inlined because two places have to agree on it and they are
 * in different bundles: the switcher renders the href and the route file mounts
 * it, and a guard in the test suite asserts they match AND that neither is
 * "/connect". That last part is the point. Legacy's own switcher points at
 * "/connect" (AccountSwitcher.tsx:112) and falls through to the callback's
 * upsert-onto-the-first-account branch, which is ruling 326's DEFECT 1: the
 * control that exists to add an account silently fails to add one.
 *
 * The path mirrors Foxhound's existing connect routes (`/connect`,
 * `/connect/callback`) rather than legacy's `/api/stripe/connect-additional`,
 * which is a Next route-handler convention this repo does not use.
 */
export const ADD_ACCOUNT_PATH = "/connect/additional";
