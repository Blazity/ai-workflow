import { env } from "../../env.js";
import type {
  McpAuditInput,
  McpEnvelope,
  McpErrorCode,
  McpPublicError as McpPublicErrorType,
  McpToolDependencies,
  McpToolName,
} from "./contracts.js";
import { McpPublicError } from "./contracts.js";
import { writeMcpAudit } from "./audit-store.js";
import {
  beginMcpMutation,
  completeMcpMutation,
  failMcpMutation,
} from "./idempotency-store.js";
import { authorizeTool, policyFor } from "./policy.js";
import { consumeMcpRateLimit } from "./rate-limit-store.js";
import { hashCanonicalJson, sanitizeMcpData } from "./sanitize-result.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

type ExecutionContext = {
  deps: McpToolDependencies;
  toolName: McpToolName;
  targetRefs: string[];
  startedAt: Date;
  inputHash: string;
  idempotencyKeyHash: string | null;
};

function publicError(error: unknown): McpPublicErrorType {
  if (error instanceof McpPublicError) return error;
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new McpPublicError("DEPENDENCY_UNAVAILABLE", "Dependency unavailable", true);
  }
  return new McpPublicError("INTERNAL_ERROR", "Internal error", false);
}

function auditOutcome(code: McpErrorCode): McpAuditInput["outcome"] {
  return code === "DEPENDENCY_UNAVAILABLE" || code === "INTERNAL_ERROR"
    ? "failed"
    : "rejected";
}

function configuredSecrets(): string[] {
  return [
    env.JIRA_API_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITLAB_TOKEN,
    env.CHAT_SDK_SLACK_TOKEN,
    env.SLACK_SIGNING_SECRET,
    env.ANTHROPIC_API_KEY,
    env.CODEX_API_KEY,
    env.CODEX_CHATGPT_OAUTH_TOKEN,
    env.GENAI_ENGINE_API_KEY,
    env.VERCEL_TOKEN,
    env.CRON_SECRET,
    env.JIRA_WEBHOOK_SECRET,
    env.GITHUB_WEBHOOK_SECRET,
    env.GITLAB_WEBHOOK_SECRET,
    env.WEBHOOK_TRIGGER_ENCRYPTION_KEY,
    env.BETTER_AUTH_SECRET,
    env.SSO_CLIENT_SECRET,
    env.RESEND_API_KEY,
    env.RESEND_WEBHOOK_SECRET,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}

async function audit(
  context: ExecutionContext,
  outcome: McpAuditInput["outcome"],
  outputHash: string | null,
  errorCode: McpErrorCode | null,
): Promise<void> {
  try {
    await writeMcpAudit(context.deps.db, {
      requestId: context.deps.requestId,
      traceId: context.deps.traceId,
      actor: context.deps.actor,
      toolName: context.toolName,
      mutationClass: policyFor(context.toolName).mutation,
      targetRefs: context.targetRefs,
      inputHash: context.inputHash,
      outputHash,
      idempotencyKeyHash: context.idempotencyKeyHash,
      outcome,
      errorCode,
      latencyMs: Math.max(0, context.deps.now().getTime() - context.startedAt.getTime()),
      occurredAt: context.deps.now(),
    });
  } catch {
    throw new McpPublicError("INTERNAL_ERROR", "Internal error", false);
  }
}

async function prepare(context: ExecutionContext): Promise<void> {
  authorizeTool(context.deps.actor, context.toolName);
  const policy = policyFor(context.toolName);
  await consumeMcpRateLimit({
    db: context.deps.db,
    actor: context.deps.actor,
    toolName: context.toolName,
    limit:
      policy.mutation === "read"
        ? env.MCP_READ_RATE_LIMIT_PER_MINUTE
        : env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE,
    now: context.startedAt,
  });
  await audit(context, "attempted", null, null);
}

function sanitize<T>(context: ExecutionContext, data: T): McpEnvelope<T> {
  return sanitizeMcpData(data, {
    requestId: context.deps.requestId,
    traceId: context.deps.traceId,
    trust: "external_untrusted",
    maxBytes: env.MCP_MAX_RESULT_BYTES,
    secrets: configuredSecrets(),
  });
}

async function auditFailure(context: ExecutionContext, error: unknown): Promise<never> {
  const safeError = publicError(error);
  await audit(context, auditOutcome(safeError.code), null, safeError.code);
  throw safeError;
}

export async function executeMcpRead<T>(input: {
  deps: McpToolDependencies;
  toolName: McpToolName;
  targetRefs: string[];
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<McpEnvelope<T>> {
  const startedAt = input.deps.now();
  const context: ExecutionContext = {
    deps: input.deps,
    toolName: input.toolName,
    targetRefs: input.targetRefs,
    startedAt,
    inputHash: hashCanonicalJson({
      targetRefs: input.targetRefs,
      toolName: input.toolName,
    }),
    idempotencyKeyHash: null,
  };
  await prepare(context);

  let envelope: McpEnvelope<T>;
  try {
    envelope = sanitize(
      context,
      await input.operation(AbortSignal.timeout(env.MCP_TOOL_TIMEOUT_MS)),
    );
  } catch (error) {
    return auditFailure(context, error);
  }

  await audit(context, "success", hashCanonicalJson(envelope.data), null);
  return envelope;
}

export async function executeMcpMutation<T>(input: {
  deps: McpToolDependencies;
  toolName: McpToolName;
  targetRefs: string[];
  idempotencyKey: string;
  payloadHash: string;
  operation: () => Promise<T>;
}): Promise<McpEnvelope<T>> {
  const startedAt = input.deps.now();
  const context: ExecutionContext = {
    deps: input.deps,
    toolName: input.toolName,
    targetRefs: input.targetRefs,
    startedAt,
    inputHash: input.payloadHash,
    idempotencyKeyHash: hashCanonicalJson(input.idempotencyKey),
  };
  await prepare(context);

  const decision = await beginMcpMutation<T>(input.deps.db, {
    organizationId: input.deps.actor.organizationId,
    actorSubject: input.deps.actor.subject,
    clientId: input.deps.actor.clientId,
    toolName: input.toolName,
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
    now: startedAt,
    expiresAt: new Date(startedAt.getTime() + IDEMPOTENCY_TTL_MS),
  });
  if (decision.kind === "replay") {
    const envelope = sanitize(context, decision.response);
    await audit(context, "success", hashCanonicalJson(envelope.data), null);
    return envelope;
  }

  const terminal = (async () => {
    let envelope: McpEnvelope<T>;
    try {
      envelope = sanitize(context, await input.operation());
    } catch (error) {
      const safeError = publicError(error);
      await failMcpMutation(input.deps.db, decision.leaseId, safeError.code);
      return auditFailure(context, safeError);
    }

    await completeMcpMutation(input.deps.db, decision.leaseId, envelope.data);
    await audit(context, "success", hashCanonicalJson(envelope.data), null);
    return envelope;
  })();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new McpPublicError(
            "DEPENDENCY_UNAVAILABLE",
            "Mutation is still running; retry with the same idempotency key",
            true,
          ),
        ),
      env.MCP_TOOL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([terminal, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
