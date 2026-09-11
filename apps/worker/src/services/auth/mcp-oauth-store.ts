import { and, eq } from "drizzle-orm";

// Better Auth OAuth persistence belongs to the authentication service cluster.

import { normalizeDashboardRole } from "@shared/contracts";

// Type only, and it has to stay that way: `auth.ts` builds the Better Auth
// instance from this module's callers, and a value import of the deployment
// connection here would validate the environment for every test that only wants
// to sign a user in. The handle arrives from the deployment instead.
import type { Db } from "../../db/client.js";
import { member, oauthClient, organization } from "../../db/schema.js";

/** What the OAuth hook needs to know about a client asking for a token. */
export interface RegisteredOAuthClient {
  referenceId: string | null;
  scopes: string[] | null;
}

/**
 * The registration behind a client id, or null when nothing is registered under
 * it. The caller decides what an unregistered client means; this only reads.
 */
export async function findRegisteredOAuthClient(
  db: Db,
  clientId: string,
): Promise<RegisteredOAuthClient | null> {
  const [client] = await db
    .select({ referenceId: oauthClient.referenceId, scopes: oauthClient.scopes })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return client ?? null;
}

/**
 * The id of the single organization this deployment serves, looked up by the slug
 * it is configured with. Null when that organization does not exist yet, which is
 * a refusal rather than a reason to fall back to another one.
 */
export async function findDeploymentOrganizationId(
  db: Db,
  slug: string,
): Promise<string | null> {
  const [fixedOrganization] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  return fixedOrganization?.id ?? null;
}

/**
 * The role this user holds in this organization, normalized to the dashboard's
 * vocabulary, or null when they hold no membership at all. A null is a refusal
 * for every caller: an access token must not carry a role nobody granted.
 */
export async function findOrganizationMemberRole(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<ReturnType<typeof normalizeDashboardRole>> {
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return membership ? normalizeDashboardRole(membership.role) : null;
}
