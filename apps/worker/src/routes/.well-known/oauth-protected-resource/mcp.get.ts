import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { defineEventHandler } from "h3";

import { env } from "../../../../env.js";
import { auth } from "../../../auth-instance.js";
import { MCP_SCOPES } from "../../../mcp/contracts.js";
import { canonicalMcpResource } from "../../../mcp/oauth.js";

export function protectedResourceMetadata(): {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
} {
  return {
    resource: canonicalMcpResource(env.BETTER_AUTH_URL),
    authorization_servers: [`${env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/auth`],
    scopes_supported: [...MCP_SCOPES],
  };
}

export default defineEventHandler(async () =>
  oauthProviderResourceClient(auth)
    .getActions()
    .getProtectedResourceMetadata(protectedResourceMetadata()),
);
