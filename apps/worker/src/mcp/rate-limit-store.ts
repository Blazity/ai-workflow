import { sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { mcpRateLimitWindows } from "../db/schema.js";
import {
  McpPublicError,
  type McpActorContext,
  type McpToolName,
} from "./contracts.js";

const WINDOW_MS = 60_000;

async function withSafeStoreErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpPublicError) throw error;
    throw new McpPublicError(
      "DEPENDENCY_UNAVAILABLE",
      "Dependency unavailable",
      true,
    );
  }
}

export async function consumeMcpRateLimit(input: {
  db: Db;
  actor: McpActorContext;
  toolName: McpToolName;
  limit: number;
  now: Date;
}): Promise<{ remaining: number; retryAfterMs: number }> {
  return withSafeStoreErrors(async () => {
    const windowStartedAt = new Date(
      Math.floor(input.now.getTime() / WINDOW_MS) * WINDOW_MS,
    );
    const retryAfterMs = WINDOW_MS - (input.now.getTime() - windowStartedAt.getTime());
    const rows = await input.db
      .insert(mcpRateLimitWindows)
      .values({
        organizationId: input.actor.organizationId,
        actorSubject: input.actor.subject,
        clientId: input.actor.clientId,
        toolName: input.toolName,
        windowStartedAt,
        requestCount: 1,
        expiresAt: new Date(windowStartedAt.getTime() + 2 * WINDOW_MS),
      })
      .onConflictDoUpdate({
        target: [
          mcpRateLimitWindows.organizationId,
          mcpRateLimitWindows.actorSubject,
          mcpRateLimitWindows.clientId,
          mcpRateLimitWindows.toolName,
          mcpRateLimitWindows.windowStartedAt,
        ],
        set: { requestCount: sql`${mcpRateLimitWindows.requestCount} + 1` },
      })
      .returning({ requestCount: mcpRateLimitWindows.requestCount });
    const requestCount = rows[0]?.requestCount ?? 1;
    if (requestCount > input.limit) {
      throw new McpPublicError(
        "RATE_LIMITED",
        "Rate limit exceeded",
        true,
        retryAfterMs,
      );
    }
    return { remaining: input.limit - requestCount, retryAfterMs };
  });
}
