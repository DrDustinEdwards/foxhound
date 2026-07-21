import { redirect } from "react-router";

import { clearDemoCookieHeader } from "~/lib/demo/session";

// Leave the read-only demo: clear the demo cookie and return to /demos. A GET is
// deliberate (the app-shell blocks non-GET in demo mode, so an Exit control must
// be a plain link); clearing a look-only cookie carries no CSRF risk.
export async function loader() {
  return redirect("/demos", { headers: { "Set-Cookie": clearDemoCookieHeader() } });
}
