import { env } from "../env.js";
import { createAuth } from "./auth.js";
import { getDb } from "./db/client.js";

/** The worker's Better Auth instance, wired from validated env. */
export const auth = createAuth(getDb(), {
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.DASHBOARD_ORIGIN],
});
