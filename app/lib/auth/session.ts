import { getAuth } from "./auth.server";

// Read the current Better Auth session from a request's cookies. Returns null
// when there is no valid session. This is the single entry point loaders,
// actions, and middleware use to learn who the caller is.
export async function getSession(env: Env, request: Request) {
  return (await getAuth(env)).api.getSession({ headers: request.headers });
}
