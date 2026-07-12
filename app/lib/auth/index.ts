// Auth module entry point. Application code imports from "~/lib/auth".
export { getAuth } from "./auth.server";
export {
  authOptions,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  MIN_PASSWORD_LENGTH,
} from "./options";
