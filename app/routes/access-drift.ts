// GET /admin/access-drift (site-runtime's ADMIN_LIST_PATH): the admin list,
// each address hashed with a fresh salt, for the daily access-drift job
// (.github/workflows/access-drift.yml), which compares it with who the Access
// application lets in. Behind the same Access application as /admin, but not
// under the admin shell: the job comes with an Access service token, which
// names no person, so adminListResponse answers only a verified service
// token's request and 404s everything else, a person's included. Its file
// sits outside app/routes/admin/, which test/admin-route-guard.test.ts keeps
// for the shell's pages.
import { adminEmails } from "@dustinedwards/site-runtime/access";
import { adminListResponse } from "@dustinedwards/site-runtime/access-drift";

import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/access-drift";

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return adminListResponse(request, env, { admins: adminEmails(env) });
}
