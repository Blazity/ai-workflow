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
  let legacyUnboundAudience = false;
  try {
    const verification = await auth.api.verifyMcpAccessToken({
      body: { token },
    });
    claims = verification.claims as Record<string, unknown>;
    legacyUnboundAudience =
      "legacyUnboundAudience" in verification &&
      verification.legacyUnboundAudience === true;
  } catch {
    throw unauthenticated();
  }

  // This endpoint only accepts Bearer presentation. A `cnf` claim makes the
  // token sender-constrained, so accepting it without validating the matching
  // request proof would weaken that constraint during rollback.
  if ("cnf" in claims) throw unauthenticated();
  if (claims.iss !== issuer) throw unauthenticated();
  if (
    claims.aud !== audience &&
    !(legacyUnboundAudience && claims.aud === undefined)
  ) {
    throw unauthenticated();
  }
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

  // Better Auth 1.6 omitted `sub` for client_credentials while 1.7 uses the
  // client id. The signed role is the stable discriminator across both shapes.
  const subject = typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  const service = claims.organization_role === "service";
  if (service && subject !== null && subject !== clientId) throw unauthenticated();
  if (!service && !subject) throw unauthenticated();

  const scopes = service
    ? withoutAuthoringScopes(intersectScopes(claims.scope, client.scopes))
    : intersectScopes(claims.scope, client.scopes);
  if (scopes.size === 0) {
    throw new McpPublicError("INSUFFICIENT_SCOPE", "Insufficient scope", false);
  }

  if (service) {
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
    .where(and(eq(member.organizationId, fixedOrganization.id), eq(member.userId, subject!)))
    .limit(1);
  const role = membership ? normalizeDashboardRole(membership.role) : null;
  if (!role) throw new McpPublicError("FORBIDDEN", "Access denied", false);

  return {
    kind: "user",
    subject: subject!,
    userId: subject!,
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
 * set is materialized. Better Auth 1.7 separates upstream token-issuance policy
 * from this resource-server authorization boundary. A client_credentials token can
 * still arrive holding registered authoring scopes, so taking them away from the
 * materialized set is the step that stops it here. The role lists on those tools
 * refuse `service` as well; this is the lock that does not depend on somebody
 * remembering to keep those lists closed.
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
