import { createAuth } from "./auth.js";
import { authDeployment } from "./services/auth/auth-deployment.js";
import { installAuthInstance } from "./services/auth/auth-instance.js";

const deployment = authDeployment();

/** The worker's Better Auth instance, composed at the app tier. */
export const auth = createAuth(deployment.db, deployment.options);

installAuthInstance(auth);
