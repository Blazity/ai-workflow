import { defineEventHandler, toWebRequest } from "h3";

import { auth } from "../../../auth-instance.js";
import {
  isOAuthDiscoveryPath,
  rollbackSafeOAuthMetadata,
} from "../../../mcp/oauth.js";

// Better Auth owns every method routed here, including OAuth issuer metadata
// requests forwarded by the deployment route, plus /api/auth/** sign-in,
// sign-out, and session endpoints. This path is intentionally NOT session-gated.
export default defineEventHandler(async (event) => {
  const request = toWebRequest(event);
  const response = await auth.handler(request);
  return isOAuthDiscoveryPath(request.url)
    ? rollbackSafeOAuthMetadata(response)
    : response;
});
