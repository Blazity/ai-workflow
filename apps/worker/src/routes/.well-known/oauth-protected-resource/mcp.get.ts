import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { defineEventHandler } from "h3";

import { auth } from "../../../auth-instance.js";
import { MCP_SCOPES } from "../../../services/mcp/contracts.js";
import { canonicalMcpResource } from "../../../mcp/oauth.js";
import { betterAuthBaseUrl } from "../../../services/settings/runtime-settings.js";

export function protectedResourceMetadata(): {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
} {
  const baseUrl = betterAuthBaseUrl();
  return {
    resource: canonicalMcpResource(baseUrl),
    authorization_servers: [`${baseUrl.replace(/\/$/, "")}/api/auth`],
    scopes_supported: [...MCP_SCOPES],
  };
}

export default defineEventHandler(async () =>
  oauthProviderResourceClient(auth)
    .getActions()
    .getProtectedResourceMetadata(protectedResourceMetadata()),
);
