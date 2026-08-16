import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getHeader,
  getHeaders,
  getRequestURL,
  send,
  setHeader,
  setResponseStatus,
  type H3Event,
} from "h3";
import type { ZodIssue } from "zod";

import { env } from "../../env.js";
import { getDb, type Db } from "../db/client.js";
import { createAdapters } from "../lib/adapters.js";
import { logger } from "../lib/logger.js";
import { writeMcpAudit } from "./audit-store.js";
import {
  MCP_UNRECOGNIZED_TOOL,
  McpPublicError,
  type McpActorContext,
  type McpAuditInput,
  type McpAuditToolName,
  type McpErrorCode,
} from "./contracts.js";
import { authorizeTool, policyFor } from "./policy.js";
import { consumeMcpRateLimit } from "./rate-limit-store.js";
import { requireMcpActor } from "./request-context.js";
import { hashCanonicalJson } from "./sanitize-result.js";
import { createMcpServer, MCP_SUPPORTED_PROTOCOL_VERSIONS } from "./server.js";
import { catalogedTool, mcpToolErrorResult } from "./tool-catalog.js";

type JsonRpcId = string | number | null;
type BoundedBodyResult =
  | { kind: "body"; body: Buffer }
  | { kind: "too_large" };
type ToolCall = { name: string; arguments: unknown };
// tools/list belongs here next to tools/call: it is the other primitive that
// enumerates this server's surface, it answers with every registered schema, and
// no tool handler runs for it, so nothing downstream would ever charge it.
type GatedRequest =
  | { kind: "call"; call: ToolCall; responds: boolean }
  | { kind: "list"; responds: boolean };
type GateVerdict =
  | { kind: "servable" }
  | { kind: "refused"; error: McpPublicError }
  // A notification carries no id, so a refusal has no reply to travel in. The
  // transport answers one with 202 and an empty body, and that is what a refused
  // notification keeps getting: a client that sent no id is not waiting for a
  // result, and handing it one makes it report an unknown message id. It is still
  // charged and still recorded.
  | { kind: "refused_silently" };

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
    drainRequest(event);
    await requestTooLarge(event);
    return;
  }

  const bodyResult = await readBoundedBody(event, env.MCP_MAX_REQUEST_BYTES);
  if (bodyResult.kind === "too_large") {
    await requestTooLarge(event);
    return;
  }
  const rawBody = bodyResult.body;

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    await writePublicError(
      event,
      400,
      new McpPublicError("VALIDATION_FAILED", "Parse error", false),
      null,
      -32700,
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

  // Read before the actor and refused here when it names nothing usable: a call
  // with no tool name has nothing to charge a budget to and nobody worth putting
  // in the audit trail, so resolving an actor (a token verification and three
  // queries) would be spent on a request already known to be refused.
  const gated = readGatedRequest(body);
  if (gated === "unnamed") {
    await writePublicError(
      event,
      400,
      new McpPublicError("VALIDATION_FAILED", "A tools/call request must name a tool", false),
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
  const db = getDb();

  // Ahead of the server and its adapters: a request this gate refuses never needs
  // either, and a refusal decided here is the only one that costs the caller
  // budget and leaves a row behind.
  if (gated) {
    let verdict: GateVerdict;
    try {
      verdict = await gateRequest({ db, actor, requestId, request: gated });
    } catch (error) {
      const publicError =
        error instanceof McpPublicError
          ? error
          : new McpPublicError("INTERNAL_ERROR", "Internal error", false);
      await writePublicError(event, statusFor(publicError.code), publicError, jsonRpcId(body));
      return;
    }
    if (verdict.kind === "refused") {
      await writeToolError(event, jsonRpcId(body), verdict.error);
      return;
    }
    if (verdict.kind === "refused_silently") {
      await writeAccepted(event);
      return;
    }
  }

  const server = createMcpServer({
    db,
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

function readGatedRequest(body: unknown): GatedRequest | "unnamed" | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const request = body as Record<string, unknown>;
  // The SDK treats a message without a string or numeric id as a notification and
  // answers it with 202 and no body, so this is what decides whether a refusal
  // has anywhere to be written.
  const id = request.id;
  const responds = typeof id === "string" || typeof id === "number";
  if (request.method === "tools/list") return { kind: "list", responds };
  if (request.method !== "tools/call") return null;
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "unnamed";
  const { name, arguments: args } = params as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0) return "unnamed";
  return { kind: "call", call: { name, arguments: args }, responds };
}

// Everything the SDK answers without ever entering a tool handler passes through
// here, because everything that protects a call lives in executeMcpRead and
// executeMcpMutation, which such a request never reaches: no budget spent, no row
// written. For an authenticated caller that is 120 free probes a minute against
// an audit trail that stays silent, whether it probes an unknown name, fuzzes the
// arguments of a real tool, lists the whole surface, or hides the whole thing in
// a notification the SDK will drop. This is where all of that pays instead,
// through the same limiter and the same audit store a served call uses, in the
// same order: cheapest guard first, then the row proving somebody tried.
async function gateRequest(input: {
  db: Db;
  actor: McpActorContext;
  requestId: string;
  request: GatedRequest;
}): Promise<GateVerdict> {
  const call = input.request.kind === "call" ? input.request.call : null;
  // Validated against the catalog the tool modules register from, never against
  // a schema restated here: a second copy would drift into refusing a legal call
  // or waving through one the SDK then bounces for free.
  const cataloged = call ? catalogedTool(call.name) : null;
  const startedAt = new Date();
  // Every unrecognized name shares one bucket. The rate-limit window is keyed by
  // tool name, so bucketing by what the caller typed would open a fresh budget
  // for every invented name and the limiter would stop limiting enumeration, the
  // one thing it is here to stop.
  const toolName: McpAuditToolName = cataloged?.name ?? MCP_UNRECOGNIZED_TOOL;
  // A call that never reached a handler applied nothing, which is what the read
  // class describes; a recognized name keeps its own class so a refused dispatch
  // is charged against the dispatch budget. Same selection as prepare() in
  // execute-tool.ts.
  const mutationClass = cataloged ? policyFor(cataloged.name).mutation : "read";

  const auditRow = (
    outcome: McpAuditInput["outcome"],
    errorCode: McpErrorCode | null,
  ): McpAuditInput => ({
    requestId: input.requestId,
    traceId: input.requestId,
    actor: input.actor,
    toolName,
    mutationClass,
    // What the caller asked for survives as a hash and nothing else: this row is
    // read later by operators and by agents, so neither an invented tool name
    // nor an argument value may travel in it as text. The hashed shape matches a
    // read's inputHash in execute-tool.ts, so an operator who suspects a given
    // name can hash it and find every probe on both paths, and tools/list is
    // findable the same way under its method name.
    targetRefs: [],
    inputHash: hashCanonicalJson({
      targetRefs: [],
      toolName: call ? call.name : "tools/list",
    }),
    outputHash: null,
    idempotencyKeyHash: null,
    outcome,
    errorCode,
    latencyMs: Math.max(0, Date.now() - startedAt.getTime()),
    occurredAt: new Date(),
  });

  // Scope and role are evaluated ahead of the schema, because
  // authorization sitting behind it (execute-tool.ts:221) made the error a caller
  // without permission gets a function of whether it also got its arguments
  // right: wrong ones said VALIDATION_FAILED, right ones said FORBIDDEN, for one
  // and the same permanent refusal. The decision itself is an in-memory check;
  // an actual refusal is still rate-limited before its audit row is written, so
  // an authenticated caller cannot turn permission probing into unbounded
  // database writes. execute-tool.ts keeps the identical authorization check for
  // paths that never pass through this gate.
  let authorizationError: McpPublicError | null = null;
  if (cataloged) {
    try {
      authorizeTool(input.actor, cataloged.name);
    } catch (error) {
      authorizationError =
        error instanceof McpPublicError
          ? error
          : new McpPublicError("INTERNAL_ERROR", "Internal error", false);
    }
  }

  const parsed =
    cataloged && call && authorizationError === null
      ? await cataloged.definition.inputSchema.safeParseAsync(call.arguments)
      : null;
  const servable = call === null || (authorizationError === null && Boolean(parsed?.success));

  // The one path that must NOT be charged here: a servable call carrying an id
  // reaches a tool handler, and execute-tool.ts charges it there. Charging it
  // twice would halve every budget. Everything else is on this gate, including a
  // servable notification, which the SDK accepts and then never executes, so
  // nothing downstream would ever charge the name-plus-arguments check it just
  // got for free.
  if (servable && input.request.responds && call !== null) return { kind: "servable" };

  const verdict = await consumeMcpRateLimit({
    db: input.db,
    actor: input.actor,
    toolName,
    limit:
      mutationClass === "read"
        ? env.MCP_READ_RATE_LIMIT_PER_MINUTE
        : env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE,
    now: startedAt,
  });

  if (!verdict.allowed) {
    // Only the first refusal of a window is recorded, as in execute-tool.ts, so
    // a flood of throttled probes cannot become a flood of rows kept for a year.
    // Fail-open: nothing ran and nothing is returned, so a lost row must not
    // dress a temporary throttle up as a permanent internal failure.
    if (verdict.firstRejectionInWindow) {
      await writeMcpAudit(input.db, auditRow("rejected", "RATE_LIMITED")).catch((error) =>
        signalAuditWriteFailure(input.requestId, toolName, error),
      );
    }
    throw new McpPublicError("RATE_LIMITED", "Rate limit exceeded", true, verdict.retryAfterMs);
  }

  if (authorizationError !== null) {
    await recordGateRow(input.db, auditRow("rejected", authorizationError.code));
    return input.request.responds
      ? { kind: "refused", error: authorizationError }
      : { kind: "refused_silently" };
  }

  await recordGateRow(
    input.db,
    servable ? auditRow("attempted", null) : auditRow("rejected", "VALIDATION_FAILED"),
  );

  if (servable) return { kind: "servable" };
  if (!input.request.responds) return { kind: "refused_silently" };
  return {
    kind: "refused",
    // VALIDATION_FAILED for both, matching the code the row above records: the
    // caller sent something this server does not serve, and the message is what
    // says which of the two it was.
    error: new McpPublicError(
      "VALIDATION_FAILED",
      cataloged && parsed && !parsed.success
        ? `Input validation error: Invalid arguments for tool ${cataloged.name}: ${describeIssues(parsed.error.issues)}`
        : unknownToolMessage(call ? call.name : ""),
      false,
    ),
  };
}

// Fail-closed, exactly like the attempted row in execute-tool.ts: for a request
// the SDK would otherwise answer for free this row is the only record that it
// happened at all, so without the row there is no request.
async function recordGateRow(db: Db, row: McpAuditInput): Promise<void> {
  try {
    await writeMcpAudit(db, row);
  } catch {
    // Reported the way the stores report their own outages, and not as an
    // INTERNAL_ERROR: the audit table and the rate-limit table live in the same
    // database, so one outage must not reach the caller once as "come back later"
    // and once as "never retry this".
    throw new McpPublicError("DEPENDENCY_UNAVAILABLE", "Dependency unavailable", true);
  }
}

const MAX_REPORTED_ISSUES = 3;

// Field names and limits, never a value the caller sent. Naming the field is the
// whole point: the commonest way a model gets a call wrong is inventing an
// argument (`limit` for `commentsLimit`), and from this gate on every blind retry
// costs it a slot and a row, so an answer it cannot act on is worse than the one
// the SDK used to give. Key names go through the same charset filter as a tool
// name, so a hostile string cannot ride back out inside the explanation.
function describeIssue(issue: ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys
      .filter((key) => SAFE_IDENTIFIER.test(key))
      .slice(0, MAX_REPORTED_ISSUES);
    return keys.length > 0
      ? `unrecognized key(s): ${keys.map((key) => `'${key}'`).join(", ")}`
      : "unrecognized key(s)";
  }
  const at = issue.path.join(".") || "(root)";
  // The boundary comes from the schema, never the value that broke it, and it is
  // what tells a caller how to correct the argument rather than guess again.
  if (issue.code === "too_big") return `${at} (too_big, max ${issue.maximum})`;
  if (issue.code === "too_small") return `${at} (too_small, min ${issue.minimum})`;
  return `${at} (${issue.code})`;
}

function describeIssues(issues: readonly ZodIssue[]): string {
  return issues.slice(0, MAX_REPORTED_ISSUES).map(describeIssue).join(", ");
}

// Guards every caller-supplied identifier that travels back out, a tool name and
// an unrecognized argument name alike: reflecting an arbitrary caller-supplied
// string into an agent's context is how a probe turns into an instruction.
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{1,64}$/u;

function unknownToolMessage(name: string): string {
  return SAFE_IDENTIFIER.test(name) ? `Tool ${name} not found` : "Tool not found";
}

function signalAuditWriteFailure(
  requestId: string,
  toolName: McpAuditToolName,
  error: unknown,
): void {
  logger.warn(
    {
      err: error instanceof Error ? error.message : String(error),
      toolName,
      requestId,
      outcome: "rejected",
    },
    "mcp_audit_write_failed",
  );
}

// A refusal keeps the SHAPE a served tool produces for the same call: 200, with
// the error carried as a tool result. The caller is an agent, and an error it
// reads as a result is what lets it correct itself; a hard JSON-RPC error would
// buy protocol tidiness by taking that away. Built by mcpToolErrorResult, the
// same function every registered tool answers a failure through, so an agent
// reads one shape and never has to know whether the gate or the handler caught
// it. The wording still differs on purpose: the argument explanation is built
// here to keep caller values out of it, and a name that cannot be echoed safely
// is dropped.
//
// Two refusals do NOT arrive this way, and the claim above is only true with
// that carve-out. RATE_LIMITED and a store failure are THROWN rather than
// returned, so they leave through writePublicError as a JSON-RPC error with a
// status (429 and 503), which an SDK client raises as a transport exception. The
// code and retryAfterMs are still on the wire in `error.data`, but an agent
// meets them as an exception, not as a result it can read. Throttling a
// recognised tool is unaffected: that charge happens inside execute-tool.ts, so
// it comes back as a 200 tool result like everything else. The split therefore
// only shows up for a name this server does not serve.
async function writeToolError(
  event: H3Event,
  id: JsonRpcId,
  error: McpPublicError,
): Promise<void> {
  setResponseStatus(event, 200);
  await send(
    event,
    JSON.stringify({ jsonrpc: "2.0", id, result: mcpToolErrorResult(error) }),
    "application/json; charset=utf-8",
  );
}

// What the SDK transport answers a notification with: 202 and an empty body. A
// refused notification keeps exactly that, because a client that sent no id has
// no message to match a body against and reports one as an unknown message id.
async function writeAccepted(event: H3Event): Promise<void> {
  setResponseStatus(event, 202);
  await send(event, "");
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

function readBoundedBody(event: H3Event, maxBytes: number): Promise<BoundedBodyResult> {
  const request = event.node.req;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (totalBytes + buffer.byteLength > maxBytes) {
        settled = true;
        chunks.length = 0;
        cleanup();
        drainRequest(event);
        resolve({ kind: "too_large" });
        return;
      }
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ kind: "body", body: Buffer.concat(chunks, totalBytes) });
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      onError(new Error("Request body stream was aborted"));
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function drainRequest(event: H3Event): void {
  const request = event.node.req;
  if (request.readableEnded || request.destroyed) return;

  const cleanup = () => {
    request.off("error", onError);
    request.off("end", cleanup);
    request.off("close", cleanup);
  };
  const onError = () => {
    // Keep the stream error handled until Node closes the request.
  };

  request.on("error", onError);
  request.once("end", cleanup);
  request.once("close", cleanup);
  request.resume();
}

function hasSupportedProtocol(event: H3Event, body: unknown): boolean {
  if (!body || typeof body !== "object") return true;
  const request = body as Record<string, unknown>;
  const headerVersion = getHeader(event, "mcp-protocol-version");
  if (request.method === "initialize") {
    const params = request.params;
    return (
      (!headerVersion || isSupportedProtocolVersion(headerVersion)) &&
      Boolean(
        params &&
          typeof params === "object" &&
          isSupportedProtocolVersion(
            (params as Record<string, unknown>).protocolVersion,
          ),
      )
    );
  }
  return typeof request.method !== "string" || isSupportedProtocolVersion(headerVersion);
}

function isSupportedProtocolVersion(value: unknown): boolean {
  return MCP_SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === value);
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
    // Not 503: reusing it would erase at the HTTP layer the very distinction
    // the code carries, since the effect may still be running.
    case "TIMEOUT":
      return 504;
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
  jsonRpcCode?: number,
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
        code: jsonRpcCode ?? (error.code === "UNAUTHENTICATED" ? -32001 : -32000),
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
