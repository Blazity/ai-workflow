import { oauthProvider, type OAuthOptions } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";

import type { Db } from "../db/client.js";
import { member, oauthClient, organization } from "../db/schema.js";
import { normalizeDashboardRole } from "../lib/auth/roles.js";
import { and, eq } from "drizzle-orm";
import { MCP_SCOPES } from "./contracts.js";

type McpOAuthDeployment = {
  baseURL: string;
  allowPublicDcr?: boolean;
  organizationId?: string;
  organizationSlug?: string;
  db?: Db;
};

type ServiceClient = {
  referenceId: string | null;
  scopes: string[] | null;
};

export type McpOAuthRequest = {
  path: string;
  body: Record<string, unknown> | undefined;
  allowPublicDcr: boolean;
  organizationId?: string;
  serviceClient?: ServiceClient | null;
};

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
  // The filter names the two authoring scopes rather than listing what to keep, so
  // "tickets:write" stays in this default deliberately: the same rule request-context.ts
  // applies, for the same reason. The platform comments on and moves tickets on every
  // run it executes with nobody behind it, so an unattended client doing that is the
  // ordinary case, and dogfood automation needs it to drive a ticket at all.
  const automationScopes = scopes.filter(
    (scope) => scope !== "prompts:write" && scope !== "workflows:write",
  );
  const resolveOrganizationId = () => deploymentOrganizationId(deployment);

  const options = {
    scopes,
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
    clientRegistrationAllowedScopes: scopes,
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
      if (!deployment.db) {
        throw new APIError("FORBIDDEN", { message: "Organization membership required" });
      }
      const [membership] = await deployment.db
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, user.id)))
        .limit(1);
      const role = membership ? normalizeDashboardRole(membership.role) : null;
      if (!role) {
        throw new APIError("FORBIDDEN", { message: "Organization membership required" });
      }
      return { organization_id: organizationId, organization_role: role };
    },
  };

  return options;
}

export function createMcpOAuthProvider(deployment: McpOAuthDeployment) {
  const options = createMcpOAuthOptions(deployment);
  return oauthProvider(options as OAuthOptions<string[]>);
}

export function validateMcpOAuthRequest(input: McpOAuthRequest): void {
  if (input.path === "/oauth2/register") {
    if (!input.allowPublicDcr) return;
    if (input.body?.token_endpoint_auth_method !== "none") {
      throw new Error("Invalid OAuth client registration");
    }
    const redirects = input.body.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0) {
      throw new Error("Invalid OAuth client registration");
    }
    if (!redirects.every((value) => typeof value === "string" && isSafeClientRedirect(value))) {
      throw new Error("Invalid OAuth client registration");
    }
    const grants = input.body.grant_types;
    if (Array.isArray(grants) && grants.some((grant) => grant === "client_credentials")) {
      throw new Error("Invalid OAuth client registration");
    }
  }

  if (input.path === "/oauth2/token" && input.body?.grant_type === "client_credentials") {
    const allowed = new Set<string>(MCP_SCOPES);
    const client = input.serviceClient;
    if (
      !client ||
      !input.organizationId ||
      client.referenceId !== input.organizationId ||
      !client.scopes?.length ||
      client.scopes.some((scope) => !allowed.has(scope))
    ) {
      throw new Error("OAuth service client is not authorized");
    }
  }
}

export async function validateMcpOAuthHookRequest(
  db: Db,
  deployment: McpOAuthDeployment,
  path: string,
  body: Record<string, unknown> | undefined,
  authorization?: string | null,
): Promise<void> {
  let organizationId: string | undefined;
  let serviceClient: ServiceClient | null | undefined;

  if (path === "/oauth2/token" && body?.grant_type === "client_credentials") {
    organizationId = await deploymentOrganizationId(deployment);
    const clientId = clientIdFromTokenRequest(body, authorization);
    if (clientId) {
      const [client] = await db
        .select({ referenceId: oauthClient.referenceId, scopes: oauthClient.scopes })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, clientId))
        .limit(1);
      serviceClient = client ?? null;
    }
  }

  try {
    validateMcpOAuthRequest({
      path,
      body,
      allowPublicDcr: deployment.allowPublicDcr ?? false,
      organizationId,
      serviceClient,
    });
  } catch {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_client_metadata",
      message: "OAuth client request rejected",
    });
  }
}

async function deploymentOrganizationId(deployment: McpOAuthDeployment): Promise<string> {
  if (deployment.organizationId) return deployment.organizationId;
  if (!deployment.db || !deployment.organizationSlug) {
    throw new APIError("FORBIDDEN", { message: "OAuth deployment organization missing" });
  }
  const [fixedOrganization] = await deployment.db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, deployment.organizationSlug))
    .limit(1);
  if (!fixedOrganization) {
    throw new APIError("FORBIDDEN", { message: "OAuth deployment organization missing" });
  }
  return fixedOrganization.id;
}

function isSafeClientRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopback(url.hostname);
  } catch {
    return false;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function clientIdFromTokenRequest(
  body: Record<string, unknown>,
  authorization?: string | null,
): string | null {
  const bodyClientId =
    typeof body.client_id === "string" && body.client_id ? body.client_id : null;
  if (!authorization?.startsWith("Basic ")) return bodyClientId;
  try {
    const encoded = authorization.slice(6);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
    ) {
      return null;
    }
    const decoded = bytes.toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1 || !decoded.slice(separator + 1)) return null;
    const basicClientId = decoded.slice(0, separator);
    if (bodyClientId && bodyClientId !== basicClientId) return null;
    return basicClientId;
  } catch {
    return null;
  }
}
