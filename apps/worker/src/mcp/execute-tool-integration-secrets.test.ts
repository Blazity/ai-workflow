import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A connected integration's secret never leaves in an MCP result.
 *
 * The redaction set used to be a list of core's own variables. An
 * integration's credential is not on it and cannot be (its variable names are
 * the integration's, and a stored connection has none), so every call now asks
 * the connection resolver for the secrets it holds. A tracing provider's key is
 * inside the sandbox by design and an agent can echo its environment into a
 * log a tool returns, so this is a real path, not a hypothetical one.
 *
 * The value is deliberately shaped like nothing: no "Bearer", no "sk-", no
 * length a token pattern would catch. Only redaction by value can remove it.
 */
const SECRET = "plainvalue7731connected";

vi.mock("../infra/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 4_096,
    MCP_TOOL_TIMEOUT_MS: 1_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 10,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 10,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));
const secretValues = vi.hoisted(() => vi.fn());

const { createTestDb } = await import("../db/test-db.js");
const { organization } = await import("../db/schema.js");
const { executeMcpMutation, executeMcpRead } = await import("./execute-tool.js");
const { depsFor } = await import("../test-support/mcp.js");
const { testSettingsSnapshot } = await import("../test-support/settings.js");

const settings = testSettingsSnapshot({
  MCP_MAX_RESULT_BYTES: 4_096,
  MCP_TOOL_TIMEOUT_MS: 1_000,
  MCP_READ_RATE_LIMIT_PER_MINUTE: 10,
});

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({ id: "org-execute", name: "Execute", slug: "execute" });
  secretValues.mockReset();
  secretValues.mockResolvedValue([SECRET]);
});

describe("an MCP result carrying a connected integration's secret", () => {
  it("comes back with the value redacted, asked for on this call", async () => {
    const result = await executeMcpRead({
      deps: depsFor(db, () => new Date("2026-09-19T10:00:00.000Z"), {
        settings,
        loadKnownSecrets: () => secretValues(),
      }),
      toolName: "runs.get",
      targetRefs: ["run:1"],
      operation: async () => ({ log: `agent printed env: KEY=${SECRET} and carried on` }),
    });

    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.data.log).toContain("[REDACTED]");
    expect(secretValues).toHaveBeenCalledTimes(1);
  });

  it("uses the set as it is now, so a key connected a minute ago is covered", async () => {
    // Asked per call rather than cached at start-up: an admin who connects an
    // integration does not redeploy the worker.
    secretValues.mockResolvedValueOnce([]).mockResolvedValueOnce([SECRET]);
    const call = () =>
      executeMcpRead({
        deps: depsFor(db, () => new Date("2026-09-19T10:00:00.000Z"), {
        settings,
        loadKnownSecrets: () => secretValues(),
      }),
        toolName: "runs.get",
        targetRefs: ["run:1"],
        operation: async () => ({ log: `KEY=${SECRET}` }),
      });

    expect(JSON.stringify(await call())).toContain(SECRET);
    expect(JSON.stringify(await call())).not.toContain(SECRET);
  });

  // Red when: a set that cannot be read is used as an empty one, so a result is
  // sanitized with the environment's secrets alone and a stored token leaves.
  it("is refused as retryable before anything runs when the secrets cannot be read", async () => {
    secretValues.mockRejectedValue(new Error("integration settings unreadable"));
    const operation = vi.fn(async () => ({ log: `KEY=${SECRET}` }));

    await expect(
      executeMcpRead({
        deps: depsFor(db, () => new Date("2026-09-19T10:00:00.000Z"), {
          settings,
          loadKnownSecrets: () => secretValues(),
        }),
        toolName: "runs.get",
        targetRefs: ["run:1"],
        operation,
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: true });
    expect(operation).not.toHaveBeenCalled();
  });

  // Red when: the refusal is raised after the idempotency key is taken, which
  // stores it as that key's outcome and makes the caller's retry a replay of a
  // failure instead of the call it asked for.
  it("leaves a mutation's idempotency key unspent, so the retry runs", async () => {
    const call = () =>
      executeMcpMutation({
        deps: depsFor(db, () => new Date("2026-09-19T10:00:00.000Z"), {
          settings,
          loadKnownSecrets: () => secretValues(),
        }),
        toolName: "workflows.dispatch",
        targetRefs: ["workflow:1"],
        idempotencyKey: "dispatch-key-secrets",
        payloadHash: "payload-secrets",
        operation: async () => ({ started: true }),
      });
    secretValues.mockRejectedValueOnce(new Error("integration settings unreadable"));

    await expect(call()).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await expect(call()).resolves.toMatchObject({ data: { started: true } });
  });
});
