import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../lib/logger.js", () => ({ logger: loggerMock }));

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
import { McpPublicError, type McpToolDependencies } from "./contracts.js";
import { executeMcpMutation, executeMcpRead } from "./execute-tool.js";
import { beginMcpMutation, failMcpMutation } from "./idempotency-store.js";
import { actorFor as actor, depsFor } from "./test-support.js";

let db: Db;
let clock: Date;

function deps(overrides: Partial<McpToolDependencies> = {}): McpToolDependencies {
  return depsFor(db, () => clock, overrides);
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({
    id: "org-execute",
    name: "Execute",
    slug: "execute",
  });
  clock = new Date("2026-08-11T12:34:30.000Z");
  loggerMock.warn.mockClear();
});

// The mutation deadline is 25ms in this fixture, so a slow operation is two
// orders of magnitude above it: no scheduler delay can reorder the two. The
// price is that its own completion has to be waited for rather than slept on.
const SLOWER_THAN_THE_DEADLINE_MS = 2_000;

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("condition was never reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function auditInsertFailingDb(source: Db, failFrom: number): Db {
  let auditInserts = 0;
  return new Proxy(source, {
    get(target, property, receiver) {
      if (property === "insert") {
        return (table: unknown) => {
          if (table === mcpAuditEvents && auditInserts++ >= failFrom) {
            throw new Error("raw audit persistence detail");
          }
          return target.insert(table as never);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

describe("executeMcpRead", () => {
  it("rates, audits the attempt, authorizes, operates, sanitizes, then audits success", async () => {
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

  it("audits the refused attempt without touching domain data when scope is missing", async () => {
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
    await expect(db.select().from(mcpRateLimitWindows)).resolves.toHaveLength(1);
    const audits = await db
      .select()
      .from(mcpAuditEvents)
      .orderBy(asc(mcpAuditEvents.occurredAt));
    expect(audits.map((row) => row.outcome)).toEqual(["attempted", "rejected"]);
    expect(audits[1]?.errorCode).toBe("INSUFFICIENT_SCOPE");
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

  it("caps the audit at one rejected row per rate limit window", async () => {
    let operations = 0;
    const read = () =>
      executeMcpRead({
        deps: deps(),
        toolName: "runs.get",
        targetRefs: ["run:rate"],
        operation: async () => {
          operations += 1;
          return { ok: true };
        },
      });

    // The fixture allows two reads a minute, so everything below is overflow
    // and a flood must not become a flood of durable rows.
    await read();
    await read();
    for (let overflow = 0; overflow < 14; overflow++) {
      await expect(read()).rejects.toMatchObject({
        code: "RATE_LIMITED",
        retryable: true,
      });
    }

    expect(operations).toBe(2);
    const firstWindow = await db.select().from(mcpAuditEvents);
    expect(firstWindow.map((row) => row.outcome).sort()).toEqual([
      "attempted",
      "attempted",
      "rejected",
      "success",
      "success",
    ]);

    clock = new Date("2026-08-11T12:35:30.000Z");
    await read();
    await read();
    await expect(read()).rejects.toMatchObject({ code: "RATE_LIMITED" });

    const rejected = (await db.select().from(mcpAuditEvents)).filter(
      (row) => row.outcome === "rejected",
    );
    expect(rejected).toHaveLength(2);
    expect(rejected.every((row) => row.errorCode === "RATE_LIMITED")).toBe(true);
  });

  it("still answers a read whose outcome audit cannot be written, and signals it", async () => {
    await expect(
      executeMcpRead({
        deps: deps({ db: auditInsertFailingDb(db, 1) }),
        toolName: "runs.get",
        targetRefs: ["run:fail-open"],
        operation: async () => ({ status: "completed" }),
      }),
    ).resolves.toMatchObject({ data: { status: "completed" } });

    const audits = await db.select().from(mcpAuditEvents);
    expect(audits.map((row) => row.outcome)).toEqual(["attempted"]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "runs.get", outcome: "success" }),
      "mcp_audit_write_failed",
    );
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

  // Node reports a transport failure as `TypeError: fetch failed` and puts the
  // real reason in `cause`, so reading only the top level files a network blip
  // as an internal bug. On a mutation that verdict is what gets stored as the
  // key's outcome, so the misreading costs a whole day of replays.
  it.each([
    {
      scenario: "aborted request",
      cause: new DOMException("The operation was aborted", "AbortError"),
    },
    { scenario: "refused connection", cause: new Error("connect ECONNREFUSED") },
  ])("classifies a $scenario hidden in cause as a dependency failure", async ({ cause }) => {
    await expect(
      executeMcpRead({
        deps: deps(),
        toolName: "runs.get",
        targetRefs: ["run:cause"],
        operation: async () => {
          throw new TypeError("fetch failed", { cause });
        },
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });

    const audits = await db.select().from(mcpAuditEvents);
    expect(audits[1]?.errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("fails safely before audit or domain work when rate persistence fails", async () => {
    const rateFailingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            if (table === mcpRateLimitWindows) {
              throw new Error("raw rate persistence detail");
            }
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
        deps: deps({ db: rateFailingDb }),
        toolName: "runs.get",
        targetRefs: [],
        operation: async () => {
          operated = true;
          return {};
        },
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });
    expect(operated).toBe(false);
    await expect(db.select().from(mcpAuditEvents)).resolves.toHaveLength(0);
  });
});

describe("executeMcpMutation", () => {
  it("audits the refused attempt without leasing when the role may not dispatch", async () => {
    let operated = false;
    await expect(
      executeMcpMutation({
        deps: deps({ actor: actor({ role: "member" }) }),
        toolName: "workflows.dispatch",
        targetRefs: ["workflow:forbidden"],
        idempotencyKey: "dispatch-key-forbidden",
        payloadHash: "payload-forbidden",
        operation: async () => {
          operated = true;
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(operated).toBe(false);
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toHaveLength(0);
    const audits = await db
      .select()
      .from(mcpAuditEvents)
      .orderBy(asc(mcpAuditEvents.occurredAt));
    expect(audits.map((row) => row.outcome)).toEqual(["attempted", "rejected"]);
    expect(audits[1]?.errorCode).toBe("FORBIDDEN");
  });

  it.each([
    {
      scenario: "different payload",
      seedFailed: false,
      requestPayloadHash: "payload-new",
      code: "IDEMPOTENCY_CONFLICT",
      outcome: "rejected",
    },
    {
      scenario: "in-flight mutation",
      seedFailed: false,
      requestPayloadHash: "payload-original",
      code: "CONFLICT",
      outcome: "rejected",
    },
    {
      scenario: "failed replay",
      seedFailed: true,
      requestPayloadHash: "payload-original",
      code: "DEPENDENCY_UNAVAILABLE",
      outcome: "failed",
    },
  ] as const)(
    "records a terminal audit when begin rejects a $scenario",
    async ({ seedFailed, requestPayloadHash, code, outcome }) => {
      const seed = await beginMcpMutation(db, {
        organizationId: "org-execute",
        actorSubject: "user:execute",
        clientId: "client-execute",
        toolName: "workflows.dispatch",
        idempotencyKey: "dispatch-key-begin",
        payloadHash: "payload-original",
        now: clock,
        expiresAt: new Date(clock.getTime() + 86_400_000),
      });
      if (seed.kind !== "execute") throw new Error("expected execution lease");
      if (seedFailed) {
        await failMcpMutation(db, seed.leaseId, "DEPENDENCY_UNAVAILABLE", clock);
      }
      let operated = false;

      await expect(
        executeMcpMutation({
          deps: deps(),
          toolName: "workflows.dispatch",
          targetRefs: ["workflow:begin"],
          idempotencyKey: "dispatch-key-begin",
          payloadHash: requestPayloadHash,
          operation: async () => {
            operated = true;
            return {};
          },
        }),
      ).rejects.toMatchObject({ code });

      expect(operated).toBe(false);
      const audits = await db
        .select()
        .from(mcpAuditEvents)
        .orderBy(asc(mcpAuditEvents.occurredAt));
      expect(audits.map((row) => row.outcome)).toEqual(["attempted", outcome]);
      expect(audits[1]?.errorCode).toBe(code);
    },
  );

  it("audits a safe begin failure after the attempted audit", async () => {
    const beginFailingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            if (table === mcpIdempotencyKeys) {
              throw new Error("raw begin persistence detail");
            }
            return target.insert(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    let operated = false;

    await expect(
      executeMcpMutation({
        deps: deps({ db: beginFailingDb }),
        toolName: "workflows.dispatch",
        targetRefs: ["workflow:begin-failure"],
        idempotencyKey: "dispatch-key-begin-failure",
        payloadHash: "payload-begin-failure",
        operation: async () => {
          operated = true;
          return {};
        },
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });

    expect(operated).toBe(false);
    const audits = await db.select().from(mcpAuditEvents);
    expect(audits.map((row) => row.outcome)).toEqual(["attempted", "failed"]);
    expect(audits[1]?.errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("marks the lease failed and audits once when completion persistence fails", async () => {
    let idempotencyUpdates = 0;
    const completionFailingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return (table: unknown) => {
            if (table === mcpIdempotencyKeys && idempotencyUpdates++ === 0) {
              throw new Error("raw completion persistence detail");
            }
            return target.update(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(
      executeMcpMutation({
        deps: deps({ db: completionFailingDb }),
        toolName: "workflows.dispatch",
        targetRefs: ["workflow:complete-failure"],
        idempotencyKey: "dispatch-key-complete-failure",
        payloadHash: "payload-complete-failure",
        operation: async () => ({ runId: "uncertain-run" }),
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });

    const stored = await db.select().from(mcpIdempotencyKeys);
    expect(stored).toMatchObject([
      { state: "failed", errorCode: "DEPENDENCY_UNAVAILABLE" },
    ]);
    const audits = await db.select().from(mcpAuditEvents);
    expect(audits.map((row) => row.outcome)).toEqual(["attempted", "failed"]);
    expect(audits[1]?.errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("still audits safely when failure persistence is unavailable", async () => {
    const failureFailingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return (table: unknown) => {
            if (table === mcpIdempotencyKeys) {
              throw new Error("raw failure persistence detail");
            }
            return target.update(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(
      executeMcpMutation({
        deps: deps({ db: failureFailingDb }),
        toolName: "workflows.dispatch",
        targetRefs: ["workflow:fail-failure"],
        idempotencyKey: "dispatch-key-fail-failure",
        payloadHash: "payload-fail-failure",
        operation: async () => {
          throw new McpPublicError("VALIDATION_FAILED", "Validation failed", false);
        },
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });

    const stored = await db.select().from(mcpIdempotencyKeys);
    expect(stored).toMatchObject([{ state: "started", errorCode: null }]);
    const audits = await db.select().from(mcpAuditEvents);
    expect(audits.map((row) => row.outcome)).toEqual(["attempted", "failed"]);
    expect(audits[1]?.errorCode).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("fails a dispatch whose outcome audit cannot be written", async () => {
    await expect(
      executeMcpMutation({
        deps: deps({ db: auditInsertFailingDb(db, 1) }),
        toolName: "workflows.dispatch",
        targetRefs: ["workflow:fail-closed"],
        idempotencyKey: "dispatch-key-fail-closed",
        payloadHash: "payload-fail-closed",
        operation: async () => ({ runId: "run-unauditable" }),
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: true,
      message: expect.stringContaining("same idempotency key"),
    });

    const audits = await db.select().from(mcpAuditEvents);
    expect(audits.map((row) => row.outcome)).toEqual(["attempted"]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

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

  // Freeing a key is not about whether the caller may retry, it is about
  // whether the effect provably never landed. "Retryable" does not know that:
  // the dispatch may have started and then failed on the way back, and paying
  // for that guess means a second run on somebody's ticket, so the key keeps
  // the verdict and the caller pays with a new key instead.
  it("keeps the key after a retryable failure that cannot rule the effect out", async () => {
    let operations = 0;
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:retryable"],
      idempotencyKey: "dispatch-key-retryable",
      payloadHash: "dispatch-payload-retryable",
      operation: async () => {
        operations += 1;
        throw new McpPublicError("DEPENDENCY_UNAVAILABLE", "Dependency unavailable", true);
      },
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toMatchObject([
      { state: "failed", errorCode: "DEPENDENCY_UNAVAILABLE" },
    ]);

    // The next rate window, so the retry is refused by nothing but the key.
    clock = new Date("2026-08-11T12:35:30.000Z");
    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: false,
      message: expect.stringContaining("new idempotency key"),
    });
    expect(operations).toBe(1);
  });

  it("frees the key when the failure proves the effect never landed", async () => {
    let operations = 0;
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:not-applied"],
      idempotencyKey: "dispatch-key-not-applied",
      payloadHash: "dispatch-payload-not-applied",
      operation: async () => {
        operations += 1;
        if (operations === 1) {
          // What a dispatch service raises before it can have started
          // anything: no capacity, so there is nothing to be uncertain about.
          throw new McpPublicError("CONFLICT", "At capacity", true, undefined, true);
        }
        return { runId: "run-after-capacity" };
      },
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toHaveLength(0);

    clock = new Date("2026-08-11T12:35:30.000Z");
    await expect(executeMcpMutation(input)).resolves.toMatchObject({
      data: { runId: "run-after-capacity" },
    });
    expect(operations).toBe(2);
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toMatchObject([
      { state: "completed" },
    ]);
  });

  it("keeps a permanent failure and replays it without operating again", async () => {
    let operations = 0;
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:permanent"],
      idempotencyKey: "dispatch-key-permanent",
      payloadHash: "dispatch-payload-permanent",
      operation: async () => {
        operations += 1;
        throw new McpPublicError("VALIDATION_FAILED", "Validation failed", false);
      },
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      retryable: false,
    });
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toMatchObject([
      { state: "failed", errorCode: "VALIDATION_FAILED" },
    ]);

    clock = new Date("2026-08-11T12:35:30.000Z");
    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      retryable: false,
    });
    expect(operations).toBe(1);
  });

  // The deadline is where a dispatch of unknown state stops being a lease. The
  // invocation behind it may be frozen the instant this reply is sent while its
  // run keeps going, so a row left "started" would come up for grabs minutes
  // later and hand somebody a second run on the same ticket. Sealing the key is
  // what makes that impossible.
  it("seals the key when the deadline claims the reply", async () => {
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:timeout-lease"],
      idempotencyKey: "dispatch-key-timeout-lease",
      payloadHash: "dispatch-payload-timeout-lease",
      operation: async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOWER_THAN_THE_DEADLINE_MS));
        return { runId: "run-still-running" };
      },
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({ code: "TIMEOUT" });

    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toMatchObject([
      { state: "failed", errorCode: "TIMEOUT" },
    ]);
    // Waited out rather than left pending, so the in-flight dispatch cannot
    // land in the middle of another test. Its late completion finds the key
    // already sealed and leaves it that way.
    await waitFor(
      () => db.select().from(mcpAuditEvents),
      (rows) => rows.length >= 3,
    );
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toMatchObject([
      { state: "failed", errorCode: "TIMEOUT" },
    ]);
  });

  it("answers a same-key retry after the deadline instead of dispatching twice", async () => {
    let operations = 0;
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:timeout-retry"],
      idempotencyKey: "dispatch-key-timeout-retry",
      payloadHash: "dispatch-payload-timeout-retry",
      operation: async () => {
        operations += 1;
        await new Promise((resolve) => setTimeout(resolve, SLOWER_THAN_THE_DEADLINE_MS));
        return { runId: "run-eventual" };
      },
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
      message: expect.stringContaining("same idempotency key"),
    });
    await waitFor(
      () => db.select().from(mcpAuditEvents),
      (rows) => rows.length >= 3,
    );

    // Exactly the move the timeout told the caller to make, and the answer is
    // the recorded verdict rather than a second dispatch. The way forward is
    // runs.get, so the replay stops promising that repeating helps.
    clock = new Date("2026-08-11T12:35:30.000Z");
    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      message: expect.stringContaining("runs.get"),
    });
    expect(operations).toBe(1);
  });

  it("leases the key for longer than an invocation lives, not for the reply deadline", async () => {
    let leaseHeldByOperation: Date | undefined;

    await executeMcpMutation({
      deps: deps(),
      toolName: "workflows.dispatch",
      targetRefs: ["workflow:lease-length"],
      idempotencyKey: "dispatch-key-lease-length",
      payloadHash: "dispatch-payload-lease-length",
      operation: async () => {
        const rows = await db.select().from(mcpIdempotencyKeys);
        leaseHeldByOperation = rows[0]?.expiresAt;
        return { runId: "run-lease" };
      },
    });

    // Minutes, and unrelated to MCP_TOOL_TIMEOUT_MS, which is 25ms here: a
    // lease measured in reply deadlines would be gone while the work behind it
    // is still running.
    expect(leaseHeldByOperation).toEqual(new Date(clock.getTime() + 15 * 60_000));
  });

  it("records a timed-out mutation as its own result row, then the real outcome", async () => {
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:timeout-audit"],
      idempotencyKey: "dispatch-key-timeout-audit",
      payloadHash: "dispatch-payload-timeout-audit",
      operation: async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOWER_THAN_THE_DEADLINE_MS));
        return { runId: "run-slow" };
      },
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
      message: expect.stringContaining("same idempotency key"),
    });

    const timedOut = await db.select().from(mcpAuditEvents);
    expect(timedOut.map((row) => row.outcome)).toEqual(["attempted", "failed"]);
    // TIMEOUT rather than DEPENDENCY_UNAVAILABLE, so an operator can tell an
    // effect of unknown state from a result that merely failed to persist.
    expect(timedOut[1]?.errorCode).toBe("TIMEOUT");

    // The effect is still in flight, so the terminal path adds its own row and
    // the operator can see the state the timeout left unknown.
    const settled = await waitFor(
      () => db.select().from(mcpAuditEvents),
      (rows) => rows.length >= 3,
    );
    expect(settled.map((row) => row.outcome)).toEqual([
      "attempted",
      "failed",
      "success",
    ]);
  });

  it("seals a timed-out key even from a lease it can no longer own", async () => {
    const input = {
      deps: deps(),
      toolName: "workflows.dispatch" as const,
      targetRefs: ["workflow:eventual"],
      idempotencyKey: "dispatch-key-eventual",
      payloadHash: "dispatch-payload-eventual",
      operation: async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOWER_THAN_THE_DEADLINE_MS));
        return { runId: "run-eventual" };
      },
    };

    await expect(executeMcpMutation(input)).rejects.toMatchObject({ code: "TIMEOUT" });

    // The dispatch lands after the seal, so its completion has no row left to
    // claim. What it must not do is undo the seal, and what it still owes the
    // operator is the record of what it did.
    await waitFor(
      () => db.select().from(mcpAuditEvents),
      (rows) => rows.length >= 3,
    );
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
      { state: "failed", errorCode: "TIMEOUT", safeResponse: null },
    ]);
    // The seal carries the response lifetime, not the lease: nothing may take
    // this key over an invocation lifetime later and dispatch again.
    expect(stored[0]?.expiresAt).toEqual(
      new Date(clock.getTime() + 24 * 60 * 60 * 1_000),
    );
  });
});
