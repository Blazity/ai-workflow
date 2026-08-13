import { createError, defineEventHandler, toWebRequest } from "h3";

import { auth } from "../../../../auth-instance.js";
import { isOpaqueHandoffToken } from "../../../../mcp/auth-pages.js";

/**
 * Server-to-server bridge for a dashboard session. The dashboard sends its
 * Better Auth bearer session here; the one-time-token plugin stores that
 * session server-side and returns only an opaque, single-use token.
 */
export default defineEventHandler(async (event) => {
  try {
    const result = await auth.api.generateOneTimeToken({
      headers: toWebRequest(event).headers,
    });
    if (!isOpaqueHandoffToken(result.token)) {
      throw new Error("Better Auth returned an invalid handoff token");
    }
    return { token: result.token };
  } catch {
    throw createError({ statusCode: 401, statusMessage: "Dashboard session required" });
  }
});
