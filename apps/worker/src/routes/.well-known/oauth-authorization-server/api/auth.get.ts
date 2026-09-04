import { defineEventHandler, toWebRequest } from "h3";

import { auth } from "../../../../auth-instance.js";
import { rollbackSafeOAuthMetadata } from "../../../../mcp/oauth.js";

export default defineEventHandler(async (event) =>
  rollbackSafeOAuthMetadata(await auth.handler(toWebRequest(event))),
);
