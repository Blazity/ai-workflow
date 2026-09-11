import { APIError } from "better-auth/api";
import { MCP_SCOPES } from "@shared/contracts";

import type { Db } from "../../db/client.js";
import { findDeploymentOrganizationId, findRegisteredOAuthClient } from "./mcp-oauth-store.js";

/** What the OAuth hook needs to know about the deployment it is guarding. */
export type McpOAuthDeployment = {
  baseURL: string;
  allowPublicDcr?: boolean;
  organizationId?: string;
  organizationSlug?: string;
  // The connection the hook reads registrations and memberships on. Optional,
  // and every lookup below refuses without it rather than reaching for a global
  // one: a deployment that was assembled without a database is not entitled to
  // answer a token request.
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

/**
 * The before hook better-auth runs on every auth request.
 *
 * The deployment it validates always carries a database, which is why the
 * parameter demands one: the handler this replaced took the connection as its
 * first argument and looked the registered client up unconditionally. Making
 * the lookup conditional here would turn a client the store knows into an
 * `invalid_client_metadata` refusal, so the requirement lives in the type.
 */
export async function validateMcpOAuthHookRequest(
  deployment: McpOAuthDeployment & { db: Db },
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
      serviceClient = await findRegisteredOAuthClient(deployment.db, clientId);
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
  const organizationId = await findDeploymentOrganizationId(deployment.db, deployment.organizationSlug);
  if (!organizationId) {
    throw new APIError("FORBIDDEN", { message: "OAuth deployment organization missing" });
  }
  return organizationId;
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
