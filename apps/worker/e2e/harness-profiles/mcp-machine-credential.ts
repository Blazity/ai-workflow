export const ENGINE_CANARY_MCP_SCOPES = [
  "mcp:read",
  "runs:dispatch",
] as const;

type FetchImplementation = typeof fetch;

export interface McpMachineCredentialOptions {
  baseUrl: string;
  bypassSecret: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchImplementation;
}

export interface McpAccessToken {
  token: string;
}

interface AuthorizationServerMetadata {
  token_endpoint?: unknown;
}

interface TokenResponse {
  access_token?: unknown;
}

function deploymentBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function authorizationServerMetadataUrl(baseUrl: URL): string {
  return new URL(
    "/.well-known/oauth-authorization-server/api/auth",
    baseUrl,
  ).toString();
}

function protectedResource(baseUrl: URL): string {
  return new URL("/mcp", baseUrl).toString();
}

function bypassHeaders(secret: string): HeadersInit {
  return { "x-vercel-protection-bypass": secret };
}

function exactTokenScopes(token: string): Set<string> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Engine canary OAuth response did not contain a JWT access token");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Engine canary OAuth access token claims are invalid");
  }
  const scope =
    claims && typeof claims === "object"
      ? (claims as Record<string, unknown>).scope
      : null;
  if (typeof scope !== "string") {
    throw new TypeError("Engine canary OAuth access token has no scope claim");
  }
  return new Set(scope.split(/\s+/).filter(Boolean));
}

function assertExactScopes(token: string): void {
  const actual = exactTokenScopes(token);
  const expected = new Set<string>(ENGINE_CANARY_MCP_SCOPES);
  if (
    actual.size !== expected.size ||
    ENGINE_CANARY_MCP_SCOPES.some((scope) => !actual.has(scope))
  ) {
    throw new Error(
      `Engine canary access token must carry the exact scopes ${ENGINE_CANARY_MCP_SCOPES.join(" ")}`,
    );
  }
}

export async function mintMcpAccessToken(
  options: McpMachineCredentialOptions,
): Promise<McpAccessToken> {
  const fetchImplementation = options.fetch ?? fetch;
  const baseUrl = deploymentBaseUrl(options.baseUrl);
  const metadataResponse = await fetchImplementation(
    authorizationServerMetadataUrl(baseUrl),
    {
      headers: bypassHeaders(options.bypassSecret),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!metadataResponse.ok) {
    throw new Error(
      `Engine canary OAuth discovery failed with status ${metadataResponse.status}`,
    );
  }
  const metadata = (await metadataResponse.json()) as AuthorizationServerMetadata;
  if (typeof metadata.token_endpoint !== "string") {
    throw new TypeError("Engine canary OAuth discovery returned no token endpoint");
  }
  const tokenEndpoint = new URL(metadata.token_endpoint);
  if (tokenEndpoint.protocol !== "https:" || tokenEndpoint.origin !== baseUrl.origin) {
    throw new Error("Engine canary OAuth token endpoint is outside the target deployment");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: options.clientId,
    client_secret: options.clientSecret,
    scope: ENGINE_CANARY_MCP_SCOPES.join(" "),
    resource: protectedResource(baseUrl),
  });
  const tokenResponse = await fetchImplementation(tokenEndpoint.toString(), {
    method: "POST",
    headers: {
      ...bypassHeaders(options.bypassSecret),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Engine canary OAuth token request failed with status ${tokenResponse.status}`,
    );
  }
  const response = (await tokenResponse.json()) as TokenResponse;
  if (typeof response.access_token !== "string" || !response.access_token) {
    throw new Error("Engine canary OAuth token response has no access token");
  }
  assertExactScopes(response.access_token);
  return { token: response.access_token };
}

export function createMcpAuthorizedFetch(
  options: McpMachineCredentialOptions,
): FetchImplementation {
  const fetchImplementation = options.fetch ?? fetch;
  let tokenPromise: Promise<McpAccessToken> | null = null;
  const accessToken = (refresh: boolean) => {
    if (refresh) tokenPromise = null;
    tokenPromise ??= mintMcpAccessToken({
      ...options,
      fetch: fetchImplementation,
    });
    return tokenPromise;
  };

  return async (input, init) => {
    const request = async (refresh: boolean) => {
      const credential = await accessToken(refresh);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credential.token}`);
      headers.set("x-vercel-protection-bypass", options.bypassSecret);
      return fetchImplementation(input, { ...init, headers });
    };

    const response = await request(false);
    return response.status === 401 ? request(true) : response;
  };
}
