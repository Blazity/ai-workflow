import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getHeader,
  getHeaders,
  getRequestURL,
  readRawBody,
  send,
  setHeader,
  setResponseStatus,
  type H3Event,
} from "h3";

import { env } from "../../env.js";
import { getDb } from "../db/client.js";
import { createAdapters } from "../lib/adapters.js";
import { McpPublicError, type McpErrorCode } from "./contracts.js";
import { requireMcpActor } from "./request-context.js";
import { createMcpServer, MCP_PROTOCOL_VERSION } from "./server.js";

type JsonRpcId = string | number | null;

export async function handleMcpPost(event: H3Event): Promise<void> {
  if (!env.MCP_ENABLED) {
    await writePublicError(
      event,
      404,
      new McpPublicError("NOT_FOUND", "Not found", false),
    );
    return;
  }

  if (!isJsonContentType(getHeader(event, "content-type"))) {
    await writePublicError(
      event,
      415,
      new McpPublicError("VALIDATION_FAILED", "Content-Type must be application/json", false),
    );
    return;
  }

  const declaredLength = Number(getHeader(event, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > env.MCP_MAX_REQUEST_BYTES) {
    await requestTooLarge(event);
    return;
  }

  const rawBody = (await readRawBody(event, false)) ?? Buffer.alloc(0);
  if (rawBody.byteLength > env.MCP_MAX_REQUEST_BYTES) {
    await requestTooLarge(event);
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    await writePublicError(
      event,
      400,
      new McpPublicError("VALIDATION_FAILED", "Invalid JSON", false),
    );
    return;
  }

  if (Array.isArray(body)) {
    await writePublicError(
      event,
      400,
      new McpPublicError("VALIDATION_FAILED", "JSON-RPC batches are not supported", false),
    );
    return;
  }
  if (!hasSupportedProtocol(event, body)) {
    await writePublicError(
      event,
      400,
      new McpPublicError("VALIDATION_FAILED", "Unsupported MCP protocol version", false),
      jsonRpcId(body),
    );
    return;
  }

  let actor;
  try {
    actor = await requireMcpActor(authRequest(event));
  } catch (error) {
    const publicError =
      error instanceof McpPublicError
        ? error
        : new McpPublicError("INTERNAL_ERROR", "Internal error", false);
    await writePublicError(event, statusFor(publicError.code), publicError);
    return;
  }

  const requestId = randomUUID();
  const server = createMcpServer({
    db: getDb(),
    adapters: createAdapters(),
    actor,
    requestId,
    traceId: requestId,
    now: () => new Date(),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let requestError: unknown;

  try {
    await server.connect(transport);
    await transport.handleRequest(event.node.req, event.node.res, body);
  } catch (error) {
    requestError = error;
  } finally {
    try {
      await server.close();
    } catch (error) {
      requestError ??= error;
    }
  }

  if (requestError && !event.node.res.writableEnded) {
    await writePublicError(
      event,
      500,
      new McpPublicError("INTERNAL_ERROR", "Internal error", false),
      jsonRpcId(body),
    );
  }
}

export async function handleMcpMethodNotAllowed(event: H3Event): Promise<void> {
  if (!env.MCP_ENABLED) {
    await writePublicError(
      event,
      404,
      new McpPublicError("NOT_FOUND", "Not found", false),
    );
    return;
  }
  setHeader(event, "Allow", "POST");
  await writePublicError(
    event,
    405,
    new McpPublicError("VALIDATION_FAILED", "Method not allowed", false),
  );
}

function authRequest(event: H3Event): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(getHeaders(event))) {
    if (value !== undefined) headers.set(name, value);
  }
  return new Request(getRequestURL(event), { method: "POST", headers });
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function hasSupportedProtocol(event: H3Event, body: unknown): boolean {
  if (!body || typeof body !== "object") return true;
  const request = body as Record<string, unknown>;
  const headerVersion = getHeader(event, "mcp-protocol-version");
  if (request.method === "initialize") {
    const params = request.params;
    return (
      (!headerVersion || headerVersion === MCP_PROTOCOL_VERSION) &&
      Boolean(
        params &&
          typeof params === "object" &&
          (params as Record<string, unknown>).protocolVersion === MCP_PROTOCOL_VERSION,
      )
    );
  }
  return typeof request.method !== "string" || headerVersion === MCP_PROTOCOL_VERSION;
}

function jsonRpcId(body: unknown): JsonRpcId {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function statusFor(code: McpErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "INSUFFICIENT_SCOPE":
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "DEPENDENCY_UNAVAILABLE":
      return 503;
    case "VALIDATION_FAILED":
      return 400;
    case "INTERNAL_ERROR":
      return 500;
  }
}

async function requestTooLarge(event: H3Event): Promise<void> {
  await writePublicError(
    event,
    413,
    new McpPublicError("VALIDATION_FAILED", "Request body is too large", false),
  );
}

async function writePublicError(
  event: H3Event,
  status: number,
  error: McpPublicError,
  id: JsonRpcId = null,
): Promise<void> {
  setResponseStatus(event, status);
  if (error.code === "UNAUTHENTICATED") {
    const metadata = new URL(env.BETTER_AUTH_URL);
    metadata.pathname = "/.well-known/oauth-protected-resource/mcp";
    metadata.search = "";
    metadata.hash = "";
    setHeader(
      event,
      "WWW-Authenticate",
      `Bearer resource_metadata="${metadata.href.replace(/\/$/, "")}", scope="mcp:read"`,
    );
  }
  await send(
    event,
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: error.code === "UNAUTHENTICATED" ? -32001 : -32000,
        message: error.message,
        data: {
          code: error.code,
          retryable: error.retryable,
          ...(error.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: error.retryAfterMs }),
        },
      },
      id,
    }),
    "application/json; charset=utf-8",
  );
}
