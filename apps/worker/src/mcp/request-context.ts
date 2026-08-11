import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { and, eq } from "drizzle-orm";

import { env } from "../../env.js";
import { auth } from "../auth-instance.js";
import { getDb } from "../db/client.js";
import { member, oauthClient, organization } from "../db/schema.js";
import { normalizeDashboardRole } from "../lib/auth/roles.js";
import {
  MCP_SCOPES,
  McpPublicError,
  type McpActorContext,
  type McpScope,
} from "./contracts.js";
import { canonicalMcpResource } from "./oauth.js";

export async function requireMcpActor(request: Request): Promise<McpActorContext> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) throw unauthenticated();

  const baseURL = env.BETTER_AUTH_URL.replace(/\/$/, "");
  const issuer = `${baseURL}/api/auth`;
  const audience = canonicalMcpResource(baseURL);
  let claims: Record<string, unknown>;
  try {
    claims = (await oauthProviderResourceClient(auth)
      .getActions()
      .verifyAccessToken(token, {
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

  const db = getDb();
  const [fixedOrganization] = await db
    .select({ id: organization.id, slug: organization.slug })
    .from(organization)
    .where(eq(organization.slug, env.DASHBOARD_ORG_SLUG))
    .limit(1);
  if (!fixedOrganization || claimOrganizationId !== fixedOrganization.id) {
    throw new McpPublicError("FORBIDDEN", "Access denied", false);
  }

  const [client] = await db
    .select({ referenceId: oauthClient.referenceId, scopes: oauthClient.scopes })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!client || client.referenceId !== fixedOrganization.id) {
    throw new McpPublicError("FORBIDDEN", "Access denied", false);
  }

  const scopes = intersectScopes(claims.scope, client.scopes);
  if (scopes.size === 0) {
    throw new McpPublicError("INSUFFICIENT_SCOPE", "Insufficient scope", false);
  }

  const userId = typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  if (!userId) {
    if (claims.organization_role !== "service") throw unauthenticated();
    return {
      kind: "service",
      subject: clientId,
      userId: null,
      clientId,
      organizationId: fixedOrganization.id,
      organizationSlug: fixedOrganization.slug,
      role: "service",
      scopes,
      audience,
    };
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, fixedOrganization.id), eq(member.userId, userId)))
    .limit(1);
  const role = membership ? normalizeDashboardRole(membership.role) : null;
  if (!role) throw new McpPublicError("FORBIDDEN", "Access denied", false);

  return {
    kind: "user",
    subject: userId,
    userId,
    clientId,
    organizationId: fixedOrganization.id,
    organizationSlug: fixedOrganization.slug,
    role,
    scopes,
    audience,
  };
}

function bearerToken(value: string | null): string | null {
  const match = /^Bearer ([^\s,]+)$/i.exec(value ?? "");
  return match?.[1] ?? null;
}

function intersectScopes(
  issued: unknown,
  clientScopes: string[] | null,
): ReadonlySet<McpScope> {
  const issuedScopes =
    typeof issued === "string" ? new Set(issued.split(/\s+/).filter(Boolean)) : new Set<string>();
  const clientAllowed = new Set(clientScopes ?? []);
  return new Set(
    MCP_SCOPES.filter((scope) => issuedScopes.has(scope) && clientAllowed.has(scope)),
  );
}

function unauthenticated(): McpPublicError {
  return new McpPublicError("UNAUTHENTICATED", "Authentication required", false);
}
