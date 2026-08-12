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
  releaseMcpMutation,
} from "./idempotency-store.js";
import { authorizeTool, policyFor } from "./policy.js";
import { consumeMcpRateLimit, type McpRateLimitVerdict } from "./rate-limit-store.js";
import { hashCanonicalJson, sanitizeMcpData } from "./sanitize-result.js";

// What a running mutation holds is a lease, not the lifetime of its answer: the
// store moves the expiry out to the response TTL the moment the row turns
// terminal. It has to outlive the invocation holding it rather than the reply
// that invocation sends, so it is a fixed span longer than a function can live
// on the platform's longest setting. Deriving it from MCP_TOOL_TIMEOUT_MS tied
// it to a number that may be configured down to a second, which would put the
// takeover deadline in the middle of a dispatch that is still working.
const MUTATION_LEASE_TTL_MS = 15 * 60 * 1_000;

// Deep enough for the wrappers a transport failure arrives in, shallow enough
// that a cyclic chain cannot spin here.
const MAX_CAUSE_DEPTH = 5;

type ExecutionContext = {
  deps: McpToolDependencies;
  toolName: McpToolName;
  targetRefs: string[];
  startedAt: Date;
  inputHash: string;
  idempotencyKeyHash: string | null;
};

// Node reports a transport failure as `TypeError: fetch failed` and puts the
// real reason in `cause`, so a check that only reads the top level files a
// network blip under INTERNAL_ERROR. That verdict is now stored as the
// idempotency key's outcome, so misreading it costs the caller a day of
// replays where a retry would have done. Walk the chain and classify by what is
// actually in it.
function publicError(error: unknown): McpPublicErrorType {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof McpPublicError) return current;
    if (!(current instanceof Error)) break;
    if (
      current.name === "AbortError" ||
      current.name === "TimeoutError" ||
      // A code bug raises a TypeError with nothing behind it; this shape is the
      // one fetch uses to wrap the reason it never reached anything.
      (current instanceof TypeError && current.cause !== undefined)
    ) {
      return new McpPublicError("DEPENDENCY_UNAVAILABLE", "Dependency unavailable", true);
    }
    current = current.cause;
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
  // Refs a tool can only name once its operation has run, so they can ride only a
  // row that carries a result. See executeMcpMutation's outcomeTargetRefs.
  extraTargetRefs: readonly string[] = [],
): Promise<void> {
  await writeMcpAudit(context.deps.db, {
    requestId: context.deps.requestId,
    traceId: context.deps.traceId,
    actor: context.deps.actor,
    toolName: context.toolName,
    mutationClass: policyFor(context.toolName).mutation,
    targetRefs: [...context.targetRefs, ...extraTargetRefs],
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
  extraTargetRefs: readonly string[] = [],
): Promise<void> {
  try {
    await audit(context, outcome, outputHash, errorCode, extraTargetRefs);
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
  /**
   * Extra target refs derived from the answer, appended to the row that carries an
   * outcome and to no other. targetRefs above are read off the ARGUMENTS, so they
   * can be settled before the attempted row; a fact a tool can only learn by
   * running (what the graph it just deployed pins, say) has nowhere to go without
   * this, and reading it before the wrapper would put an unmetered, unauthorized,
   * unaudited query in front of the gates.
   *
   * Applied to the replay path too: a replayed answer is the same answer, so its
   * row says the same thing about it. Never to a failure, which has no answer to
   * derive anything from. Must be pure and must not throw: it runs after the effect
   * has landed, where nothing can be undone.
   */
  outcomeTargetRefs?: (data: T) => string[];
  operation: (leaseId: string) => Promise<T>;
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
  const outcomeRefs = (data: T): string[] => input.outcomeTargetRefs?.(data) ?? [];
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
      expiresAt: new Date(startedAt.getTime() + MUTATION_LEASE_TTL_MS),
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
    await auditResult(
      context,
      "success",
      hashCanonicalJson(envelope.data),
      null,
      outcomeRefs(envelope.data),
    );
    return envelope;
  }

  // Raised the moment the deadline takes the reply, before the seal below is
  // written: from that point the key's outcome is not the terminal path's to
  // decide any more. The terminal path still attempts its own transitions,
  // because a seal that failed to commit leaves it as the only writer that can
  // still settle the row; the flag only tells it how to read a refusal.
  let sealedByDeadline = false;

  const terminal = (async () => {
    let envelope: McpEnvelope<T>;
    try {
      envelope = sanitize(context, await input.operation(decision.leaseId));
    } catch (error) {
      let safeError = publicError(error);
      try {
        // The key is given back only for a failure that proves the effect never
        // landed, never merely because the caller may try again: a dispatch can
        // fail on the way back from a run it already started, and a key handed
        // back there buys a second run on the same ticket. Anything else,
        // including plain uncertainty, is stored as this key's outcome.
        if (safeError.effectNotApplied) {
          await releaseMcpMutation(input.deps.db, decision.leaseId);
        } else {
          await failMcpMutation(
            input.deps.db,
            decision.leaseId,
            safeError.code,
            input.deps.now(),
          );
        }
      } catch (persistenceError) {
        // Under a seal the transition above was refused because the deadline
        // already stored a verdict, which is not a second failure to report:
        // what the caller gets was decided at the deadline, and the audit below
        // still owes the operator what the dispatch really did.
        if (!sealedByDeadline) safeError = publicError(persistenceError);
      }
      return auditFailure(context, safeError);
    }

    try {
      await completeMcpMutation(
        input.deps.db,
        decision.leaseId,
        envelope.data,
        input.deps.now(),
      );
    } catch (error) {
      const safeError = publicError(error);
      try {
        // Failed, never released, whatever the error says about retrying: the
        // operation already landed and only its answer was lost, so handing the
        // key back would buy a retry that dispatches a second time.
        await failMcpMutation(
          input.deps.db,
          decision.leaseId,
          safeError.code,
          input.deps.now(),
        );
      } catch {
        // The completion outcome is uncertain, but the public error and audit
        // remain safe even when the fallback lease transition is unavailable.
      }
      if (sealedByDeadline) {
        // The dispatch did land, and the only reason it could not be stored is
        // that the deadline sealed the key first. The caller has its answer
        // already, so what is left is the record of the real outcome.
        await auditResult(
          context,
          "success",
          hashCanonicalJson(envelope.data),
          null,
          outcomeRefs(envelope.data),
        );
        return envelope;
      }
      return auditFailure(context, safeError);
    }
    await auditResult(
      context,
      "success",
      hashCanonicalJson(envelope.data),
      null,
      outcomeRefs(envelope.data),
    );
    return envelope;
  })();

  // TIMEOUT, not DEPENDENCY_UNAVAILABLE: the caller is not looking at a dead
  // backend, it is looking at its own dispatch which is still running and may
  // already have landed. Repeating this key is NOT the way forward, because the
  // seal below stores the timeout as the key's outcome, so a repeat can only
  // ever replay that verdict: the message has to name the two moves that do
  // lead somewhere, reviewing the subject's runs and dispatching under a new
  // key. Codes do not survive the SDK's tool-error path, so the message is the
  // only channel that reaches the caller here.
  const timedOutError = new McpPublicError(
    "TIMEOUT",
    "The dispatch is still running and may already have been applied; retrying with the same idempotency key cannot change that, because this key now carries the timeout as its outcome, so review the runs for this subject to see whether one started, and dispatch again under a new idempotency key",
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
    sealedByDeadline = true;
    // The dispatch keeps running and may already have started a run, so the key
    // is sealed with the deadline's verdict rather than left holding a lease.
    // A row still "started" here is the whole danger: this invocation can be
    // frozen the instant the reply is sent while its run finishes on its own,
    // and one lease later the key would be free for a retry to dispatch a
    // second run on the same ticket. Best-effort, because if the operation
    // settled the row first then its outcome is the truth and this finds
    // nothing to change.
    await failMcpMutation(
      input.deps.db,
      decision.leaseId,
      timedOutError.code,
      input.deps.now(),
    ).catch((sealError) =>
      logger.warn(
        {
          err: sealError instanceof Error ? sealError.message : String(sealError),
          toolName: context.toolName,
          requestId: context.deps.requestId,
        },
        "mcp_timeout_seal_failed",
      ),
    );
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
