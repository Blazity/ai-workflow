import { defineEventHandler, toWebRequest } from "h3";

import { auth } from "../../../auth-instance.js";

// Better Auth owns every method under /api/auth/** (sign-in, sign-out,
// get-session, …). Nitro/h3 speaks Web Request/Response, so we just adapt the
// event and hand off. This path is intentionally NOT session-gated.
export default defineEventHandler((event) => auth.handler(toWebRequest(event)));
