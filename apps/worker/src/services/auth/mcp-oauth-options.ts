/**
 * The OAuth provider this deployment mounts for MCP: dynamic client
 * registration, the consent and login pages, the audience every token is minted
 * for, and the claims an access token carries.
 *
 * Protocol wiring only. What a registration or a token request is allowed to be,
 * and every lookup those answers depend on, is `services/mcp`'s oauth policy,
 * re-exported below so `auth.ts` and this module's tests keep one import.
 */
import { APIError } from "better-auth/api";
import { MCP_SCOPES } from "@shared/contracts";

import {
  findDeploymentOrganizationId,
  findOrganizationMemberRole,
} from "./mcp-oauth-store.js";
import type { McpOAuthDeployment } from "./mcp-oauth-policy.js";

export {
  validateMcpOAuthHookRequest,
  validateMcpOAuthRequest,
} from "./mcp-oauth-policy.js";
export type {
  McpOAuthDeployment,
} from "./mcp-oauth-policy.js";

export function canonicalMcpResource(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/mcp`;
  return url.href.replace(/\/$/, "");
}

export function createMcpOAuthOptions(deployment: McpOAuthDeployment) {
  const baseURL = deployment.baseURL.replace(/\/$/, "");
  const scopes = [...MCP_SCOPES];
  // What a client_credentials grant gets when NOTHING else says otherwise, and that
  // is the whole of what it is: hygiene, not a lock. The provider prefers the
  // client's own registered scopes over this default
  // (@better-auth/oauth-provider@1.6.20, dist/index.mjs:725), dynamic registration
  // writes every advertised scope into those whenever the registration names none
  // (dist/index.mjs:1244), and an explicit `scope` on the token request is validated
  // against that same full list (dist/index.mjs:708-724), so a token issued to an
  // unattended client can still come out holding the authoring scopes. The place
  // they are actually taken away is request-context.ts, where the actor's scope set
  // is materialized from the token and the client row; keeping the default narrow
  // here only means a client that registered with no scopes at all is not handed
  // more than it asked for.
  //
  // The filter names the person-only scopes rather than listing what to keep, so
  // "tickets:write" stays in this default deliberately: the same rule request-context.ts
  // applies, for the same reason. The platform comments on and moves tickets on every
  // run it executes with nobody behind it, so an unattended client doing that is the
  // ordinary case, and dogfood automation needs it to drive a ticket at all.
  const automationScopes = scopes.filter(
    (scope) =>
      scope !== "prompts:write" &&
      scope !== "workflows:write" &&
      // The catalog and the settings registry are configuration of the
      // deployment itself, and request-context.ts strips them from a token with
      // no `sub` for the same reason it strips the two above.
      scope !== "repositories:write" &&
      scope !== "settings:write",
  );
  // offline_access is the standard OAuth2/OIDC marker a client sends to ask for a
  // refresh token, the same way Atlassian and Supabase do it. It is advertised and
  // registrable so an interactive client can opt in, but it is permission-inert:
  // request-context.ts materializes an actor's scope set by intersecting the token's
  // issued scopes against MCP_SCOPES, so offline_access never becomes a permission.
  // It stays out of both defaults below, so it is opt-in and never written into an
  // unattended client's grant.
  const OFFLINE_ACCESS = "offline_access";
  const advertisedScopes = [...scopes, OFFLINE_ACCESS];
  const resolveOrganizationId = async (): Promise<string> => {
    if (deployment.organizationId) return deployment.organizationId;
    if (!deployment.organizationSlug) {
      throw new APIError("FORBIDDEN", { message: "OAuth deployment organization missing" });
    }
    if (!deployment.db && !deployment.findOrganizationId) {
      throw new APIError("FORBIDDEN", { message: "OAuth deployment organization missing" });
    }
    const organizationId = deployment.findOrganizationId
      ? await deployment.findOrganizationId(deployment.organizationSlug)
      : await findDeploymentOrganizationId(deployment.db!, deployment.organizationSlug);
    if (!organizationId) {
      throw new APIError("FORBIDDEN", { message: "OAuth deployment organization missing" });
    }
    return organizationId;
  };

  const options = {
    scopes: advertisedScopes,
    validAudiences: [canonicalMcpResource(baseURL)],
    grantTypes: [
      "authorization_code",
      "client_credentials",
      "refresh_token",
    ] as Array<"authorization_code" | "client_credentials" | "refresh_token">,
    loginPage: `${baseURL}/mcp-auth/login`,
    consentPage: `${baseURL}/mcp-auth/consent`,
    allowPublicClientPrelogin: true,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: deployment.allowPublicDcr ?? false,
    clientRegistrationDefaultScopes: scopes,
    clientRegistrationAllowedScopes: advertisedScopes,
    clientCredentialGrantDefaultScopes: automationScopes,
    codeChallengeMethodsSupported: ["S256"] as const,
    silenceWarnings: { oauthAuthServerConfig: true },
    clientReference: async ({ session }: { session?: Record<string, unknown> }) => {
      const fixedOrganizationId = await resolveOrganizationId();
      if (session && session.activeOrganizationId !== fixedOrganizationId) {
        throw new APIError("FORBIDDEN", {
          message: "OAuth client organization is not active",
        });
      }
      return fixedOrganizationId;
    },
    customAccessTokenClaims: async ({
      user,
    }: {
      user?: { id: string } | null;
      scopes: string[];
      referenceId?: string;
      resource?: string;
      metadata?: Record<string, unknown>;
    }) => {
      const organizationId = await resolveOrganizationId();
      if (!user) {
        return { organization_id: organizationId, organization_role: "service" };
      }
      if (!deployment.db && !deployment.findMemberRole) {
        throw new APIError("FORBIDDEN", { message: "Organization membership required" });
      }
      const role = deployment.findMemberRole
        ? await deployment.findMemberRole(organizationId, user.id)
        : await findOrganizationMemberRole(deployment.db!, organizationId, user.id);
      if (!role) {
        throw new APIError("FORBIDDEN", { message: "Organization membership required" });
      }
      return { organization_id: organizationId, organization_role: role };
    },
  };

  return options;
}
