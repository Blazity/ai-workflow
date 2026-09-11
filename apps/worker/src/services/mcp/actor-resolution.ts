import { normalizeDashboardRole } from "@shared/contracts";

import {
  findConnectedMcpMemberRole,
  findConnectedMcpOauthClient,
  findConnectedMcpOrganizationBySlug,
} from "../../db/repositories/mcp.js";
import { dashboardOrganizationSettings } from "../settings/index.js";
import { MCP_SCOPES, McpPublicError, type McpActorContext, type McpScope } from "./contracts.js";

/** The claims the transport has already verified against the issuer's JWKS. */
export interface VerifiedMcpTokenClaims {
  /** The client the token was issued to (`azp`). */
  clientId: string;
  /** The organization the token names (`organization_id`). */
  organizationId: string;
  /** The person behind the token, or null for a service token. */
  userId: string | null;
  /** Whether the token claims the service role, which allows a missing subject. */
  serviceRole: boolean;
  /** The space-separated scope string the token was issued with. */
  issuedScope: unknown;
  /** The resource this token was verified against, carried into the actor. */
  audience: string;
}

/**
 * Turn verified token claims into the actor a tool call runs as.
 *
 * Everything the transport could decide from the token alone happened before
 * this: signature, issuer, audience and the presence of the two claims below.
 * What is left needs the database, because the organization is fixed by
 * deployment, the client's registered scopes cap what any of its tokens may do,
 * and a person's role comes from their membership row. All three are refusals
 * with the same public answer, so a caller cannot tell which one it failed.
 */
export async function resolveMcpActor(
  claims: VerifiedMcpTokenClaims,
): Promise<McpActorContext> {
  const fixedOrganization = await findConnectedMcpOrganizationBySlug(
    dashboardOrganizationSettings().slug,
  );
  if (!fixedOrganization || claims.organizationId !== fixedOrganization.id) {
    throw new McpPublicError("FORBIDDEN", "Access denied", false);
  }

  const client = await findConnectedMcpOauthClient(claims.clientId);
  if (!client || client.referenceId !== fixedOrganization.id) {
    throw new McpPublicError("FORBIDDEN", "Access denied", false);
  }

  // Decided before the scope set is built, because whether anybody is behind this
  // token changes what the set may contain. A missing `sub` is legal only for a
  // service token.
  const userId = claims.userId;
  if (!userId && !claims.serviceRole) throw unauthenticated();

  const scopes = userId
    ? intersectScopes(claims.issuedScope, client.scopes)
    : withoutAuthoringScopes(intersectScopes(claims.issuedScope, client.scopes));
  if (scopes.size === 0) {
    throw new McpPublicError("INSUFFICIENT_SCOPE", "Insufficient scope", false);
  }

  if (!userId) {
    return {
      kind: "service",
      subject: claims.clientId,
      userId: null,
      clientId: claims.clientId,
      organizationId: fixedOrganization.id,
      organizationSlug: fixedOrganization.slug,
      role: "service",
      scopes,
      audience: claims.audience,
    };
  }

  const membership = await findConnectedMcpMemberRole({
    organizationId: fixedOrganization.id,
    userId,
  });
  const role = membership ? normalizeDashboardRole(membership.role) : null;
  if (!role) throw new McpPublicError("FORBIDDEN", "Access denied", false);

  return {
    kind: "user",
    subject: userId,
    userId,
    clientId: claims.clientId,
    organizationId: fixedOrganization.id,
    organizationSlug: fixedOrganization.slug,
    role,
    scopes,
    audience: claims.audience,
  };
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
 * to keep those lists closed.
 *
 * "tickets:write" is deliberately NOT taken away, and the difference is the point: the
 * platform comments on and transitions tickets without a human behind it on every run
 * it executes, so that is not a class of action a fresh consent screen guards. Writing
 * a prompt or a workflow definition is. */
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
