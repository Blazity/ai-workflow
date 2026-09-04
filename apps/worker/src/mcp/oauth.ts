import { createHash, timingSafeEqual } from "node:crypto";
import { decodeBasicCredentials } from "@better-auth/core/oauth2";
import {
  getOAuthProviderApi,
  oauthProvider,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { APIError, createAuthEndpoint } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth/types";
import { z } from "zod";

import type { Db } from "../db/client.js";
import {
  member,
  oauthClient,
  oauthClientResource,
  oauthResource,
  organization,
} from "../db/schema.js";
import { normalizeDashboardRole } from "../lib/auth/roles.js";
import { and, eq } from "drizzle-orm";
import { MCP_SCOPES } from "./contracts.js";

type McpOAuthDeployment = {
  baseURL: string;
  allowPublicDcr?: boolean;
  allowLegacyUnboundAccessTokens?: boolean;
  organizationId?: string;
  organizationSlug?: string;
  db?: Db;
};

type ServiceClient = {
  referenceId: string | null;
  scopes: string[] | null;
  clientCredentialsScopes: string[] | null;
};

export type McpOAuthRequest = {
  path: string;
  body: Record<string, unknown> | undefined;
  query?: Record<string, unknown>;
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

const rollbackTokenAuthMethods = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
const rollbackEndpointAuthMethods = [
  "client_secret_basic",
  "client_secret_post",
] as const;

/** Keep discovery aligned with the auth methods allowed while 1.6 is rollbackable. */
export async function rollbackSafeOAuthMetadata(
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  const document = await response
    .clone()
    .json()
    .catch(() => null);
  if (!recordValue(document)) return response;

  document.token_endpoint_auth_methods_supported = [...rollbackTokenAuthMethods];
  if ("introspection_endpoint_auth_methods_supported" in document) {
    document.introspection_endpoint_auth_methods_supported = [
      ...rollbackEndpointAuthMethods,
    ];
  }
  if ("revocation_endpoint_auth_methods_supported" in document) {
    document.revocation_endpoint_auth_methods_supported = [
      ...rollbackEndpointAuthMethods,
    ];
  }
  delete document.token_endpoint_auth_signing_alg_values_supported;
  delete document.introspection_endpoint_auth_signing_alg_values_supported;
  delete document.revocation_endpoint_auth_signing_alg_values_supported;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(document), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function isOAuthDiscoveryPath(url: string): boolean {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  return (
    pathname === "/api/auth/.well-known/openid-configuration" ||
    pathname === "/api/auth/.well-known/oauth-authorization-server"
  );
}

export function createMcpOAuthOptions(
  deployment: McpOAuthDeployment,
  publicDcrInitialAccessToken?: string,
) {
  if (deployment.allowPublicDcr && !publicDcrInitialAccessToken) {
    throw new Error("Public OAuth client registration requires an internal marker");
  }

  const baseURL = deployment.baseURL.replace(/\/$/, "");
  const canonicalResource = canonicalMcpResource(baseURL);
  const scopes = [...MCP_SCOPES];
  // offline_access is the standard OAuth2/OIDC marker a client sends to ask for a
  // refresh token. Better Auth 1.7 persists the deterministic union of the DCR
  // default and allowed scopes, so it is a registered client capability even when
  // omitted from the registration request. It is still not an authorization grant:
  // a refresh token is issued only when offline_access is explicitly requested and
  // consented, and request-context.ts never materializes it as an MCP permission.
  const OFFLINE_ACCESS = "offline_access";
  const advertisedScopes = [...scopes, OFFLINE_ACCESS];
  const resolveOrganizationId = () => deploymentOrganizationId(deployment);

  const options = {
    scopes: advertisedScopes,
    resources: [canonicalResource],
    resourceSeedMode: "insertOnly",
    // Keep the pre-1.7 authorization behavior throughout the rollback window.
    // AIW-330/334 prepare the links before a separately authorized cutover.
    enforcePerClientResources: false,
    grantTypes: [
      "authorization_code",
      "client_credentials",
      "refresh_token",
    ],
    loginPage: `${baseURL}/mcp-auth/login`,
    consentPage: `${baseURL}/mcp-auth/consent`,
    allowPublicClientPrelogin: true,
    allowDynamicClientRegistration: true,
    // Public MCP DCR is token-backed, never open. createAuth injects a
    // per-instance marker only when the caller supplied no Authorization header.
    allowUnauthenticatedClientRegistration: false,
    storeTokens: "hashed",
    // Better Auth otherwise accepts an optional valid DPoP proof and issues a
    // sender-constrained token even when neither client nor resource requires it.
    // Keep issuance completely closed throughout the rollback window.
    dpop: { signingAlgorithms: [] },
    ...(deployment.allowPublicDcr && publicDcrInitialAccessToken
      ? {
          validateInitialAccessToken: async ({
            initialAccessToken,
          }: {
            initialAccessToken: string;
          }) =>
            initialAccessTokensEqual(initialAccessToken, publicDcrInitialAccessToken)
              ? { referenceId: await resolveOrganizationId() }
              : false,
        }
      : {}),
    clientRegistrationDefaultScopes: scopes,
    clientRegistrationAllowedScopes: advertisedScopes,
    clientRegistrationDefaultResources: [canonicalResource],
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
      resources?: string[];
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
  } satisfies OAuthOptions<string[]>;

  return options;
}

/**
 * Mount the OAuth provider and its private protected-resource verifier over the
 * exact same resolved options. The verifier is an auth.api-only capability: a
 * SERVER_ONLY endpoint has no HTTP route and therefore cannot become an
 * unauthenticated introspection surface.
 */
export function createMcpOAuthPlugins(
  deployment: McpOAuthDeployment,
  publicDcrInitialAccessToken?: string,
) {
  const options = createMcpOAuthOptions(deployment, publicDcrInitialAccessToken);
  const provider = oauthProvider(options);
  return [
    provider,
    createMcpAccessTokenVerifierPlugin(deployment, provider.options),
  ] as const;
}

const verifyMcpAccessTokenBody = z.object({ token: z.string().min(1) });

function createMcpAccessTokenVerifierPlugin(
  deployment: McpOAuthDeployment,
  options: ReturnType<typeof createMcpOAuthOptions>,
) {
  return {
    id: "mcp-oauth-access-token-verifier",
    endpoints: {
      verifyMcpAccessToken: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: verifyMcpAccessTokenBody,
        },
        async (ctx) => {
          const provider = getOAuthProviderApi(ctx, options);
          const claims = (await provider.requireActiveAccessToken(
            ctx.body.token,
          )) as Record<string, unknown>;

          // Sender-constrained tokens stay closed until the MCP transport
          // validates the corresponding proof (AIW-332 cutover scope).
          if ("cnf" in claims) throw invalidMcpAccessToken();

          const organizationId =
            typeof claims.organization_id === "string"
              ? claims.organization_id
              : null;
          const claimedClientId =
            typeof claims.azp === "string" && claims.azp
              ? claims.azp
              : null;
          if (
            !organizationId ||
            !claimedClientId ||
            claims.client_id !== claimedClientId ||
            !(await hasEnabledCanonicalResourceLink(
              deployment,
              claimedClientId,
              organizationId,
            ))
          ) {
            throw invalidMcpAccessToken();
          }

          // JWTs have no oauth_access_token row. A matching hashed row proves
          // that an opaque value was issued by this provider; never infer the
          // legacy exception from a merely missing `aud` claim.
          const storedToken = await provider.hashToken(ctx.body.token, "access_token");
          const accessToken = (await ctx.context.adapter.findOne({
            model: "oauthAccessToken",
            where: [{ field: "token", value: storedToken }],
          })) as Record<string, unknown> | null;

          if (!accessToken) return ctx.json({ claims });

          const clientId =
            typeof accessToken.clientId === "string" ? accessToken.clientId : null;
          const subject = typeof claims.sub === "string" && claims.sub ? claims.sub : null;
          const service = claims.organization_role === "service";
          const rowUserId =
            typeof accessToken.userId === "string" && accessToken.userId
              ? accessToken.userId
              : null;
          const legacyUnbound =
            accessToken.resources === null ||
            (Array.isArray(accessToken.resources) && accessToken.resources.length === 0);
          const legacyNullReference =
            legacyUnbound && accessToken.referenceId === null;
          if (
            !clientId ||
            clientId !== claimedClientId ||
            (!legacyNullReference && accessToken.referenceId !== organizationId) ||
            accessToken.confirmation !== null ||
            (rowUserId
              ? service || subject !== rowUserId
              : !service || (subject !== null && subject !== clientId))
          ) {
            throw invalidMcpAccessToken();
          }

          if (legacyUnbound) {
            if (!deployment.allowLegacyUnboundAccessTokens) {
              throw invalidMcpAccessToken();
            }
            if (claims.aud !== undefined) throw invalidMcpAccessToken();
            return ctx.json({ claims, legacyUnboundAudience: true as const });
          }

          return ctx.json({ claims });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

async function hasEnabledCanonicalResourceLink(
  deployment: McpOAuthDeployment,
  clientId: string,
  organizationId: string,
): Promise<boolean> {
  if (!deployment.db) return false;
  const resource = canonicalMcpResource(deployment.baseURL);
  const [link] = await deployment.db
    .select({ id: oauthClientResource.id })
    .from(oauthClientResource)
    .innerJoin(
      oauthResource,
      eq(oauthResource.identifier, oauthClientResource.resourceId),
    )
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthClientResource.clientId))
    .where(
      and(
        eq(oauthClientResource.clientId, clientId),
        eq(oauthClientResource.resourceId, resource),
        eq(oauthResource.disabled, false),
        eq(oauthClient.referenceId, organizationId),
        eq(oauthClient.disabled, false),
      ),
    )
    .limit(1);
  return Boolean(link);
}

function invalidMcpAccessToken(): APIError {
  return new APIError("UNAUTHORIZED", {
    error: "invalid_token",
    message: "Invalid MCP access token",
  });
}

export function validateMcpOAuthRequest(input: McpOAuthRequest): void {
  const clientMetadata = oauthClientMetadata(input.path, input.body);
  if (clientMetadata) {
    const authMethod = clientMetadata.token_endpoint_auth_method;
    const nestedMetadata = recordValue(clientMetadata.metadata);
    if (
      clientMetadata.dpop_bound_access_tokens === true ||
      nestedMetadata?.dpop_bound_access_tokens === true ||
      (authMethod !== undefined &&
        !["none", "client_secret_basic", "client_secret_post"].includes(
          String(authMethod),
        )) ||
      (nestedMetadata?.token_endpoint_auth_method !== undefined &&
        !["none", "client_secret_basic", "client_secret_post"].includes(
          String(nestedMetadata.token_endpoint_auth_method),
        ))
    ) {
      throw new Error("Invalid OAuth client registration");
    }
  }

  if (
    input.path.startsWith("/admin/oauth2/resources") &&
    input.body?.dpopBoundAccessTokensRequired === true
  ) {
    throw new Error("Invalid OAuth resource configuration");
  }

  if (hasDpopAuthorizationBinding(input.path, input.body, input.query)) {
    throw new Error("DPoP authorization is disabled during rollback");
  }

  if (input.path === "/oauth2/register") {
    const body = input.body;

    // Authenticated registration may remain available when public DCR is off,
    // but the rollback window still excludes DPoP and auth methods unsupported
    // by Better Auth 1.6. The stricter public-client shape below applies only
    // when the unauthenticated MCP registration surface is enabled.
    if (!input.allowPublicDcr) return;
    if (body?.token_endpoint_auth_method !== "none") {
      throw new Error("Invalid OAuth client registration");
    }
    const redirects = body.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0) {
      throw new Error("Invalid OAuth client registration");
    }
    if (!redirects.every((value) => typeof value === "string" && isSafeClientRedirect(value))) {
      throw new Error("Invalid OAuth client registration");
    }
    const grants = body.grant_types;
    if (Array.isArray(grants) && grants.some((grant) => grant === "client_credentials")) {
      throw new Error("Invalid OAuth client registration");
    }
    if (
      body.application_type === undefined &&
      redirects.every(
        (value) => typeof value === "string" && isSafeHttpLoopbackRedirect(value),
      )
    ) {
      // Better Auth 1.7 defaults an omitted application_type to "web", which
      // rejects RFC 8252 loopback redirects. Preserve the safe legacy request by
      // making its already-proven native shape explicit for the downstream handler.
      body.application_type = "native";
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
      !client.clientCredentialsScopes?.length ||
      client.scopes.some((scope) => !isValidServiceScope(scope, allowed)) ||
      client.clientCredentialsScopes.some((scope) => !isValidServiceScope(scope, allowed)) ||
      !arraysEqual(client.scopes, client.clientCredentialsScopes)
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
  query?: Record<string, unknown>,
): Promise<void> {
  let organizationId: string | undefined;
  let serviceClient: ServiceClient | null | undefined;

  if (path === "/oauth2/token" && body?.grant_type === "client_credentials") {
    organizationId = await deploymentOrganizationId(deployment);
    const clientId = clientIdFromTokenRequest(body, authorization);
    if (clientId) {
      const [client] = await db
        .select({
          referenceId: oauthClient.referenceId,
          scopes: oauthClient.scopes,
          clientCredentialsScopes: oauthClient.clientCredentialsScopes,
        })
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
      query,
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

function oauthClientMetadata(
  path: string,
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (
    path === "/oauth2/register" ||
    path === "/oauth2/create-client" ||
    path === "/admin/oauth2/create-client"
  ) {
    return body;
  }
  if (path === "/admin/oauth2/update-client") {
    return recordValue(body?.update);
  }
}

function hasDpopAuthorizationBinding(
  path: string,
  body: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
): boolean {
  if (
    path !== "/oauth2/authorize" &&
    path !== "/oauth2/consent" &&
    path !== "/oauth2/continue"
  ) {
    return false;
  }
  if (body?.dpop_jkt !== undefined || query?.dpop_jkt !== undefined) return true;
  const oauthQuery = body?.oauth_query;
  return (
    typeof oauthQuery === "string" &&
    new URLSearchParams(oauthQuery).has("dpop_jkt")
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function isSafeHttpLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      url.protocol === "http:" &&
      isLoopback(url.hostname)
    );
  } catch {
    return false;
  }
}

function isValidServiceScope(scope: unknown, allowed: ReadonlySet<string>): scope is string {
  return (
    typeof scope === "string" &&
    scope.length > 0 &&
    scope === scope.trim() &&
    scope !== "offline_access" &&
    allowed.has(scope)
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function initialAccessTokensEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
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
  if (!authorization?.match(/^Basic +/i)) return bodyClientId;
  try {
    const { clientId: basicClientId } = decodeBasicCredentials(authorization);
    if (bodyClientId && bodyClientId !== basicClientId) return null;
    return basicClientId;
  } catch {
    return null;
  }
}
