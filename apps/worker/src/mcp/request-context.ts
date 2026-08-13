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

  // Decided before the scope set is built, because whether anybody is behind this
  // token changes what the set may contain. A missing `sub` is legal only for a
  // service token.
  const userId = typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  if (!userId && claims.organization_role !== "service") throw unauthenticated();

  const scopes = userId
    ? intersectScopes(claims.scope, client.scopes)
    : withoutAuthoringScopes(intersectScopes(claims.scope, client.scopes));
  if (scopes.size === 0) {
    throw new McpPublicError("INSUFFICIENT_SCOPE", "Insufficient scope", false);
  }

  if (!userId) {
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

/** A token with no `sub` has nobody behind it: it is the shape smoke and dogfood
 * automation uses, and it must not act as an author. The prompt library is the
 * instruction set every future run is handed, and a workflow definition is what the
 * platform then carries out with its own repository credentials, so both writes need
 * a consent screen a person stood in front of.
 *
 * This is where the narrowing has to happen, because it is where the actor's scope
 * set is materialized. oauth.ts declares clientCredentialGrantDefaultScopes, but
 * that is only a DEFAULT: @better-auth/oauth-provider@1.6.20 prefers the client's
 * own registered scopes over it (dist/index.mjs:725), dynamic registration writes
 * every advertised scope into those when the request names none
 * (dist/index.mjs:1244), and an explicit `scope` on the token request is checked
 * against the same full list (dist/index.mjs:708-724). So a client_credentials
 * token really can arrive holding these two, and taking them away from the issued
 * set is the only step that stops it. The role lists on those tools refuse
 * `service` as well; this is the lock that does not depend on somebody remembering
 * to keep those lists closed. */
function withoutAuthoringScopes(scopes: ReadonlySet<McpScope>): ReadonlySet<McpScope> {
  return new Set(
    [...scopes].filter((scope) => scope !== "prompts:write" && scope !== "workflows:write"),
  );
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
