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
import { logger } from "../lib/logger.js";
import { writeMcpAudit } from "./audit-store.js";
import {
  beginMcpMutation,
  completeMcpMutation,
  failMcpMutation,
} from "./idempotency-store.js";
import { authorizeTool, policyFor } from "./policy.js";
import { consumeMcpRateLimit, type McpRateLimitVerdict } from "./rate-limit-store.js";
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
}

// The attempted row is fail-closed for every tool class, reads included: it is
// the record proving the call happened, so without it there is no call.
async function auditAttempt(context: ExecutionContext): Promise<void> {
  try {
    await audit(context, "attempted", null, null);
  } catch {
    throw new McpPublicError("INTERNAL_ERROR", "Internal error", false);
  }
}

function signalAuditWriteFailure(
  context: ExecutionContext,
  outcome: McpAuditInput["outcome"],
  error: unknown,
): void {
  logger.warn(
    {
      err: error instanceof Error ? error.message : String(error),
      toolName: context.toolName,
      requestId: context.deps.requestId,
      outcome,
    },
    "mcp_audit_write_failed",
  );
}

// The outcome row is written once the work is already done. Losing it must not
// lose a read's answer, so reads degrade to a signal an operator can alert on.
// Mutations stay fail-closed towards the caller: the effect did land, but the
// caller may not treat an unauditable dispatch as confirmed, so it is told to
// settle the uncertainty rather than that nothing happened.
async function auditResult(
  context: ExecutionContext,
  outcome: McpAuditInput["outcome"],
  outputHash: string | null,
  errorCode: McpErrorCode | null,
): Promise<void> {
  try {
    await audit(context, outcome, outputHash, errorCode);
  } catch (error) {
    if (policyFor(context.toolName).mutation !== "read") {
      throw new McpPublicError(
        "INTERNAL_ERROR",
        "The operation may already have been applied; retry with the same idempotency key or confirm the state with runs.get",
        true,
      );
    }
    signalAuditWriteFailure(context, outcome, error);
  }
}

// A throttled call is the one legitimate shape that records a "rejected" row
// with no "attempted" row before it: the limiter refuses before the attempt is
// on record. Only the first refusal of a window is written, so an alert must
// read neither the missing "attempted" nor the missing later rows as tampering.
async function rejectRateLimited(
  context: ExecutionContext,
  verdict: Extract<McpRateLimitVerdict, { allowed: false }>,
): Promise<never> {
  if (verdict.firstRejectionInWindow) {
    try {
      await audit(context, "rejected", null, "RATE_LIMITED");
    } catch (error) {
      // Nothing ran and nothing is returned, so a lost row must never dress a
      // temporary throttle up as a permanent internal failure.
      signalAuditWriteFailure(context, "rejected", error);
    }
  }
  throw new McpPublicError(
    "RATE_LIMITED",
    "Rate limit exceeded",
    true,
    verdict.retryAfterMs,
  );
}

async function prepare(context: ExecutionContext): Promise<void> {
  const policy = policyFor(context.toolName);
  // Cheapest guard first, and ahead of the attempted row on purpose: a caller
  // over its budget writes at most one row per window, so a flood of refused
  // calls cannot become a flood of rows kept for a year. An unreachable rate
  // store keeps propagating untouched: it is infrastructure failure on the very
  // database the audit row would need.
  const verdict = await consumeMcpRateLimit({
    db: context.deps.db,
    actor: context.deps.actor,
    toolName: context.toolName,
    limit:
      policy.mutation === "read"
        ? env.MCP_READ_RATE_LIMIT_PER_MINUTE
        : env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE,
    now: context.startedAt,
  });
  if (!verdict.allowed) await rejectRateLimited(context, verdict);
  await auditAttempt(context);
  // Authorization runs after the attempted row on purpose: that row is the only
  // record a refused call leaves behind, and an operator needs to see who tried.
  try {
    authorizeTool(context.deps.actor, context.toolName);
  } catch (error) {
    await auditFailure(context, error);
  }
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
  await auditResult(context, auditOutcome(safeError.code), null, safeError.code);
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

  await auditResult(context, "success", hashCanonicalJson(envelope.data), null);
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

  let decision: Awaited<ReturnType<typeof beginMcpMutation<T>>>;
  try {
    decision = await beginMcpMutation<T>(input.deps.db, {
      organizationId: input.deps.actor.organizationId,
      actorSubject: input.deps.actor.subject,
      clientId: input.deps.actor.clientId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      now: startedAt,
      expiresAt: new Date(startedAt.getTime() + IDEMPOTENCY_TTL_MS),
    });
  } catch (error) {
    return auditFailure(context, error);
  }
  if (decision.kind === "replay") {
    let envelope: McpEnvelope<T>;
    try {
      envelope = sanitize(context, decision.response);
    } catch (error) {
      return auditFailure(context, error);
    }
    await auditResult(context, "success", hashCanonicalJson(envelope.data), null);
    return envelope;
  }

  const terminal = (async () => {
    let envelope: McpEnvelope<T>;
    try {
      envelope = sanitize(context, await input.operation());
    } catch (error) {
      let safeError = publicError(error);
      try {
        await failMcpMutation(input.deps.db, decision.leaseId, safeError.code);
      } catch (persistenceError) {
        safeError = publicError(persistenceError);
      }
      return auditFailure(context, safeError);
    }

    try {
      await completeMcpMutation(input.deps.db, decision.leaseId, envelope.data);
    } catch (error) {
      const safeError = publicError(error);
      try {
        await failMcpMutation(input.deps.db, decision.leaseId, safeError.code);
      } catch {
        // The completion outcome is uncertain, but the public error and audit
        // remain safe even when the fallback lease transition is unavailable.
      }
      return auditFailure(context, safeError);
    }
    await auditResult(context, "success", hashCanonicalJson(envelope.data), null);
    return envelope;
  })();

  // TIMEOUT, not DEPENDENCY_UNAVAILABLE: the caller is not looking at a dead
  // backend, it is looking at its own dispatch which is still running and may
  // already have landed. Retrying with the same key is safe, and the code makes
  // that actionable without reading the message.
  const timedOutError = new McpPublicError(
    "TIMEOUT",
    "The dispatch is still running and may already have been applied; retry with the same idempotency key or confirm the state with runs.get",
    true,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(timedOutError), env.MCP_TOOL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([terminal, timedOut]);
  } catch (error) {
    // Identity, not the code: everything the terminal path raises has already
    // audited its own outcome, and only this verdict is still unrecorded.
    if (error !== timedOutError) throw error;
    // The effect keeps running, so this row means "state unknown at the
    // deadline", and the terminal path adds the real outcome as a second row
    // for the same request. Swallow a lost row rather than replace a retryable
    // timeout with an internal error the caller would read as final.
    await audit(context, "failed", null, timedOutError.code).catch((auditError) =>
      signalAuditWriteFailure(context, "failed", auditError),
    );
    throw timedOutError;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
