import { readFileSync } from "node:fs";

import { createApp, toWebHandler } from "h3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { member, organization, user } from "../../../../db/schema.js";
import { createTestDb } from "../../../../db/test-db.js";

// The secret-shaped values are here so the "no secrets" assertion has something
// real to fail on: an env this route can reach, holding values that must never
// reach a response body.
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
    MCP_ENABLED: true,
    MCP_SERVER_VERSION: "0.1.0",
    MCP_ALLOW_PUBLIC_DCR: false,
    MCP_AUDIT_RETENTION_DAYS: 365,
    MCP_MAX_REQUEST_BYTES: 1_048_576,
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_DOGFOOD_FIXTURE_PREFIX: "mcp-dogfood",
    MAX_CONCURRENT_AGENTS: 3,
    DATABASE_URL: "postgres://fixture-user:fixture-db-password@db.fixture/worker",
    GITHUB_TOKEN: "ghp_fixtureReadinessTokenAAAAAAAAAAAAAAAA",
    JIRA_API_TOKEN: "fixture-jira-token-8e21",
  },
}));

vi.mock("../../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        state.sessionUserId
          ? { user: { id: state.sessionUserId }, session: { id: "session_test" } }
          : null,
      ),
    },
  },
}));

const mcpReadinessGet = (await import("./mcp-readiness.get.js")).default;
const { MCP_CONTRACT_SNAPSHOT_PATH } = await import(
  "../../../../mcp/contract-artifact.js"
);

const committed = JSON.parse(readFileSync(MCP_CONTRACT_SNAPSHOT_PATH, "utf8")) as {
  contractHash: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function request() {
  return handlerFor(mcpReadinessGet)(new Request("http://worker.test/"));
}

/** Every scalar the payload carries, at any depth, for the env-leak assertion. */
function jsonLeaves(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(jsonLeaves);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(jsonLeaves);
  }
  return [value];
}

// Built once, unlike its sibling route tests: this route only reads the org
// membership the guard checks, so a fresh migration replay per test bought nothing
// and cost more than vitest's 10s hook budget allows.
beforeAll(async () => {
  const db = await createTestDb();
  state.db = db;
  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    {
      id: "user_outsider",
      name: "Outsider",
      email: "outsider@example.com",
      emailVerified: true,
    },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
  ]);
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  state.env.MCP_ENABLED = true;
});

describe("GET /api/v1/system/mcp-readiness", () => {
  it("rejects a request with no session with 401", async () => {
    state.sessionUserId = null;
    expect((await request()).status).toBe(401);
  });

  it("rejects a user outside the dashboard org with 403", async () => {
    state.sessionUserId = "user_outsider";
    expect((await request()).status).toBe(403);
  });

  // The whole payload, as an exact object: an operator reads this to decide whether
  // a client failure is the deployment's fault, so a field silently appearing or
  // disappearing matters as much as a wrong value.
  it("reports the surface this deployment serves and nothing else", async () => {
    const res = await request();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      enabled: true,
      serverVersion: "0.1.0",
      protocolVersion: "2025-11-25",
      contractHash: committed.contractHash,
      toolCount: 12,
      tools: [
        "system.capabilities",
        "tickets.get",
        "tickets.list_runs",
        "runs.get",
        "runs.trace",
        "runs.result",
        "runs.diagnose",
        "workflows.dispatch_preflight",
        "workflows.dispatch",
        "workflows.list",
        "prompts.list",
        "prompts.get",
      ],
      enabledDomains: ["system", "tickets", "runs", "workflows", "prompts"],
    });
  });

  // Readiness is the one MCP fact an operator can read without a token for the MCP
  // server itself, which makes it the endpoint someone will be tempted to grow into
  // a config reader. Pinned by walking every value the mocked env holds, so a field
  // added to the payload later fails here rather than at the next security review.
  //
  // Compared value by value, not as a substring of the body: the byte caps and rate
  // limits are small numbers, and the payload carries a 64-character hex hash that
  // would sooner or later contain "20" or "120" by chance.
  it("publishes no env value beyond the switch and the version", async () => {
    const body = (await (await request()).json()) as unknown;
    const leaves = jsonLeaves(body);
    const published: unknown[] = [state.env.MCP_ENABLED, state.env.MCP_SERVER_VERSION];

    for (const [key, value] of Object.entries(state.env)) {
      if (published.includes(value)) continue;
      expect(leaves, `env.${key} must not reach the readiness payload`).not.toContain(
        value,
      );
    }
    // Credentials additionally as substrings, because a credential that arrived
    // inside a longer string would slip past a value comparison.
    const text = JSON.stringify(body);
    for (const credential of [
      state.env.DATABASE_URL,
      state.env.GITHUB_TOKEN,
      state.env.JIRA_API_TOKEN,
      "fixture-db-password",
    ]) {
      expect(text).not.toContain(credential);
    }
  });

  // Whether MCP is switched on here is the first question this endpoint exists to
  // answer, so it has to track the flag rather than report a constant.
  it("reports MCP as disabled when this deployment has it switched off", async () => {
    state.env.MCP_ENABLED = false;

    expect(await (await request()).json()).toMatchObject({ enabled: false });
  });

  // Leg two of the three-way, pivoting on the committed snapshot exactly as
  // src/mcp/contract-artifact.test.ts's system.capabilities leg does. Together they
  // pin the operator's view, the client's view and the artifact to one contract: if
  // any of the three drifted, one of these two assertions goes red.
  it("reports the contract hash the committed artifact publishes", async () => {
    const body = (await (await request()).json()) as { contractHash: string };

    expect(body.contractHash).toBe(committed.contractHash);
    expect(body.contractHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
