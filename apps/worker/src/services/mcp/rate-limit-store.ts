import type { Db } from "../../db/types.js";
import {
  consumeConnectedMcpRateLimitWindow,
  consumeMcpRateLimitWindow,
  sweepConnectedExpiredMcpRateLimitWindows,
  sweepExpiredMcpRateLimitWindows,
} from "../../db/repositories/mcp.js";
import { logger } from "../../infra/logger.js";
import {
  McpPublicError,
  type McpActorContext,
  type McpAuditToolName,
} from "./contracts.js";

const WINDOW_MS = 60_000;

// The caller decides what a refusal costs, so the limiter reports its verdict
// instead of throwing it: only the first refusal of a window is worth an audit
// row, and that fact lives here, in the counter.
export type McpRateLimitVerdict =
  | { allowed: true; remaining: number; retryAfterMs: number }
  | { allowed: false; firstRejectionInWindow: boolean; retryAfterMs: number };

async function withSafeStoreErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpPublicError) throw error;
    // The public error deliberately carries no driver detail, so this is the
    // only place the real cause of an MCP-wide 503 can still be read.
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "mcp_rate_limit_store_failed",
    );
    throw new McpPublicError(
      "DEPENDENCY_UNAVAILABLE",
      "Dependency unavailable",
      true,
    );
  }
}

// Windows expire two minutes after they open and nothing reads them again, but
// the rows stay until something removes them. The cron calls this.
export async function sweepMcpRateLimits(db: Db, now: Date = new Date()): Promise<void> {
  await sweepExpiredMcpRateLimitWindows(db, now);
}

export function sweepConnectedMcpRateLimits(now: Date = new Date()): Promise<void> {
  return sweepConnectedExpiredMcpRateLimitWindows(now);
}

export async function consumeMcpRateLimit(input: {
  db: Db;
  actor: McpActorContext;
  // Widened past McpToolName for the transport gate: a refused call has to spend
  // budget too, and the name it spent it on may not be a tool at all.
  toolName: McpAuditToolName;
  limit: number;
  now: Date;
}): Promise<McpRateLimitVerdict> {
  return withSafeStoreErrors(async () => {
    const windowStartedAt = new Date(
      Math.floor(input.now.getTime() / WINDOW_MS) * WINDOW_MS,
    );
    const retryAfterMs = WINDOW_MS - (input.now.getTime() - windowStartedAt.getTime());
    const requestCount = await consumeMcpRateLimitWindow(input.db, {
      organizationId: input.actor.organizationId,
      actorSubject: input.actor.subject,
      clientId: input.actor.clientId,
      toolName: input.toolName,
      windowStartedAt,
      expiresAt: new Date(windowStartedAt.getTime() + 2 * WINDOW_MS),
    });
    if (requestCount > input.limit) {
      // The upsert is atomic, so exactly one request per window observes the
      // count crossing the limit. That one is the window's auditable verdict.
      return {
        allowed: false,
        firstRejectionInWindow: requestCount === input.limit + 1,
        retryAfterMs,
      };
    }
    return { allowed: true, remaining: input.limit - requestCount, retryAfterMs };
  });
}

export async function consumeConnectedMcpRateLimit(
  input: Omit<Parameters<typeof consumeMcpRateLimit>[0], "db">,
): Promise<McpRateLimitVerdict> {
  return withSafeStoreErrors(async () => {
    const windowStartedAt = new Date(
      Math.floor(input.now.getTime() / WINDOW_MS) * WINDOW_MS,
    );
    const retryAfterMs = WINDOW_MS - (input.now.getTime() - windowStartedAt.getTime());
    const requestCount = await consumeConnectedMcpRateLimitWindow({
      organizationId: input.actor.organizationId,
      actorSubject: input.actor.subject,
      clientId: input.actor.clientId,
      toolName: input.toolName,
      windowStartedAt,
      expiresAt: new Date(windowStartedAt.getTime() + 2 * WINDOW_MS),
    });
    if (requestCount > input.limit) {
      return {
        allowed: false,
        firstRejectionInWindow: requestCount === input.limit + 1,
        retryAfterMs,
      };
    }
    return { allowed: true, remaining: input.limit - requestCount, retryAfterMs };
  });
}
