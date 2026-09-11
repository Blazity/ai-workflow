import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

import { auth } from "../auth-instance.js";
import { resolveMcpActor } from "../services/mcp/actor-resolution.js";
import { McpPublicError } from "../services/mcp/contracts.js";
import { betterAuthBaseUrl } from "../services/settings/runtime-settings.js";
import type { McpActorContext } from "./contracts.js";
import { canonicalMcpResource } from "./oauth.js";

/**
 * Turn a request's bearer token into the actor its tool call runs as.
 *
 * Everything here is protocol: pull the token off the header, verify it against
 * the issuer's JWKS, and check that it was minted for this resource. What the
 * claims then mean (which organization, which client registration, which
 * membership role, which scopes survive) is a database-backed decision and lives
 * in the MCP service, so this file holds no query and no environment read.
 */
export async function requireMcpActor(request: Request): Promise<McpActorContext> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) throw unauthenticated();

  const baseURL = betterAuthBaseUrl().replace(/\/$/, "");
  const issuer = `${baseURL}/api/auth`;
  const audience = canonicalMcpResource(baseURL);
  let claims: Record<string, unknown>;
  try {
    claims = (await oauthProviderResourceClient(auth)
      .getActions()
      .verifyAccessToken(token, {
        // The resource client reads auth.options.basePath before Better Auth
        // applies its default, so without this it probes /jwks instead of the
        // mounted /api/auth/jwks endpoint and rejects every valid token.
        jwksUrl: `${issuer}/jwks`,
        verifyOptions: { issuer, audience },
      })) as Record<string, unknown>;
  } catch {
    throw unauthenticated();
  }

  if (claims.aud !== audience) throw unauthenticated();
  const clientId = typeof claims.azp === "string" ? claims.azp : null;
  const claimOrganizationId =
    typeof claims.organization_id === "string" ? claims.organization_id : null;
  if (!clientId || !claimOrganizationId) throw unauthenticated();

  return resolveMcpActor({
    clientId,
    organizationId: claimOrganizationId,
    userId: typeof claims.sub === "string" && claims.sub ? claims.sub : null,
    serviceRole: claims.organization_role === "service",
    issuedScope: claims.scope,
    audience,
  });
}

function bearerToken(value: string | null): string | null {
  const match = /^Bearer ([^\s,]+)$/i.exec(value ?? "");
  return match?.[1] ?? null;
}

function unauthenticated(): McpPublicError {
  return new McpPublicError("UNAUTHENTICATED", "Authentication required", false);
}
