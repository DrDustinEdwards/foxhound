import { getAuth } from "./auth.server";

// Read the current Better Auth session from a request's cookies. Returns null
// when there is no valid session. This is the single entry point loaders,
// actions, and middleware use to learn who the caller is.
export async function getSession(env: Env, request: Request) {
  return (await getAuth(env)).api.getSession({ headers: request.headers });
}

/** This person's sessions, from Better Auth's /list-sessions, and the current
 *  one's token; null when signed out. Throws SESSION_NOT_FRESH without a
 *  sign-in from the last 10 minutes. */
export async function listSessions(env: Env, request: Request) {
  const auth = await getAuth(env);
  const current = await auth.api.getSession({ headers: request.headers });
  if (!current) return null;
  return { sessions: await auth.api.listSessions({ headers: request.headers }), token: current.session.token };
}
