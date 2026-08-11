import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 4_096,
    MCP_TOOL_TIMEOUT_MS: 25,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 2,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 1,
    MCP_AUDIT_RETENTION_DAYS: 365,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_WEBHOOK_SECRET: undefined,
    GITLAB_TOKEN: undefined,
    JIRA_API_TOKEN: undefined,
    SLACK_SIGNING_SECRET: undefined,
  },
}));

import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import {
  mcpAuditEvents,
  mcpIdempotencyKeys,
  mcpRateLimitWindows,
  organization,
} from "../db/schema.js";
import type { Adapters } from "../lib/adapters.js";
import type { McpActorContext, McpToolDependencies } from "./contracts.js";
import { executeMcpMutation, executeMcpRead } from "./execute-tool.js";

let db: Db;
let clock: Date;

function actor(overrides: Partial<McpActorContext> = {}): McpActorContext {
  return {
    kind: "user",
    subject: "user:execute",
    userId: "user-execute",
    clientId: "client-execute",
    organizationId: "org-execute",
    organizationSlug: "execute",
    role: "admin",
    scopes: new Set(["mcp:read", "runs:dispatch"]),
    audience: "https://worker.example.com/mcp",
    ...overrides,
  };
}

function deps(overrides: Partial<McpToolDependencies> = {}): McpToolDependencies {
  return {
    db,
    adapters: {} as Adapters,
    actor: actor(),
    requestId: "request-execute",
    traceId: "trace-execute",
    now: () => clock,
    ...overrides,
  };
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({
    id: "org-execute",
    name: "Execute",
    slug: "execute",
  });
  clock = new Date("2026-08-11T12:34:30.000Z");
});

describe("executeMcpRead", () => {
  it("authorizes, rates, audits the attempt, operates, sanitizes, then audits success", async () => {
    let stateSeenByOperation: { rateCount: number; auditOutcomes: string[] } | undefined;
    const result = await executeMcpRead({
      deps: deps(),
      toolName: "runs.get",
      targetRefs: ["run:17"],
      operation: async () => {
        const rateRows = await db.select().from(mcpRateLimitWindows);
        const auditRows = await db
          .select()
          .from(mcpAuditEvents)
          .orderBy(asc(mcpAuditEvents.occurredAt));
        stateSeenByOperation = {
          rateCount: rateRows[0]?.requestCount ?? 0,
          auditOutcomes: auditRows.map((row) => row.outcome),
        };
        return { note: "Authorization: Bearer execute-fixture-secret" };
      },
    });

    expect(stateSeenByOperation).toEqual({ rateCount: 1, auditOutcomes: ["attempted"] });
    expect(result.data.note).toBe("Authorization: Bearer [REDACTED]");
    const audits = await db
      .select()
      .from(mcpAuditEvents)
      .orderBy(asc(mcpAuditEvents.occurredAt));
    expect(audits.map((row) => row.outcome)).toEqual(["attempted", "success"]);
    expect(audits[1]?.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(audits)).not.toContain("execute-fixture-secret");
  });

  it("does not touch rate, audit, or domain data when authorization fails", async () => {
    let operated = false;
    await expect(
      executeMcpRead({
        deps: deps({ actor: actor({ scopes: new Set() }) }),
        toolName: "runs.get",
        targetRefs: [],
        operation: async () => {
          operated = true;
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });

    expect(operated).toBe(false);
    await expect(db.select().from(mcpRateLimitWindows)).resolves.toHaveLength(0);
    await expect(db.select().from(mcpAuditEvents)).resolves.toHaveLength(0);
  });

  it("fails closed when the attempted audit cannot be written", async () => {
    const auditFailingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            if (table === mcpAuditEvents) throw new Error("audit unavailable");
            return target.insert(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    let operated = false;

    await expect(
      executeMcpRead({
        deps: deps({ db: auditFailingDb }),
        toolName: "runs.get",
        targetRefs: [],
        operation: async () => {
          operated = true;
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
    expect(operated).toBe(false);
  });

  it("aborts a timed-out read and records only a safe public failure", async () => {
    let aborted = false;
    await expect(
      executeMcpRead({
        deps: deps(),
        toolName: "runs.trace",
        targetRefs: ["run:timeout"],
        operation: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: true });

    expect(aborted).toBe(true);
    const audits = await db.select().from(mcpAuditEvents);
    expect(audits.map((row) => row.outcome)).toEqual(["attempted", "failed"]);
    expect(audits[1]).toMatchObject({
      errorCode: "DEPENDENCY_UNAVAILABLE",
      outputHash: null,
    });
  });
});

describe("executeMcpMutation", () => {
  it("rates and audits before acquiring idempotency, then replays without operating twice", async () => {
    let operations = 0;
    let stateSeenByOperation:
      | { rateCount: number; auditOutcomes: string[]; idempotencyState: string | undefined }
      | undefined;
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:17"],
      idempotencyKey: "dispatch-key-17",
      payloadHash: "dispatch-payload-hash-17",
      operation: async () => {
        operations += 1;
        const rateRows = await db.select().from(mcpRateLimitWindows);
        const auditRows = await db.select().from(mcpAuditEvents);
        const idempotencyRows = await db.select().from(mcpIdempotencyKeys);
        stateSeenByOperation = {
          rateCount: rateRows[0]?.requestCount ?? 0,
          auditOutcomes: auditRows.map((row) => row.outcome),
          idempotencyState: idempotencyRows[0]?.state,
        };
        return { runId: "run-dispatched" };
      },
    };

    await expect(executeMcpMutation(input)).resolves.toMatchObject({
      data: { runId: "run-dispatched" },
    });
    expect(stateSeenByOperation).toEqual({
      rateCount: 1,
      auditOutcomes: ["attempted"],
      idempotencyState: "started",
    });

    clock = new Date("2026-08-11T12:35:00.000Z");
    await expect(executeMcpMutation(input)).resolves.toMatchObject({
      data: { runId: "run-dispatched" },
    });
    expect(operations).toBe(1);
  });

  it("returns a retry-same-key timeout while preserving eventual completion", async () => {
    let operations = 0;
    const operation = async () => {
      operations += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { runId: "run-eventual" };
    };
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:eventual"],
      idempotencyKey: "dispatch-key-eventual",
      payloadHash: "dispatch-payload-eventual",
      operation,
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
      message: expect.stringContaining("same idempotency key"),
    });
    await new Promise((resolve) => setTimeout(resolve, 70));

    const stored = await db
      .select()
      .from(mcpIdempotencyKeys)
      .where(
        and(
          eq(mcpIdempotencyKeys.organizationId, "org-execute"),
          eq(mcpIdempotencyKeys.idempotencyKey, "dispatch-key-eventual"),
        ),
      );
    expect(stored).toMatchObject([
      { state: "completed", safeResponse: { runId: "run-eventual" } },
    ]);

    clock = new Date("2026-08-11T12:35:00.000Z");
    await expect(executeMcpMutation(input)).resolves.toMatchObject({
      data: { runId: "run-eventual" },
    });
    expect(operations).toBe(1);
  });
});
