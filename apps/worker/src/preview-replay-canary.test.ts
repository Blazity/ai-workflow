import { describe, expect, it, vi } from "vitest";
import type {
  ReplayRedactionClass,
  ReplaySanitizedEnvelope,
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import {
  assertReplayCanaryEvidence,
  createReplayCanaryFixture,
  parseReplayCanaryEnv,
  type ReplayCanaryEvidence,
} from "../e2e/replay/canary-contract.js";
import {
  createMcpAuthorizedFetch,
  ENGINE_CANARY_MCP_SCOPES,
  mintMcpAccessToken,
} from "../e2e/harness-profiles/mcp-machine-credential.js";

const replayEnv = {
  REPLAY_CANARY_LOG_EXPORT_PATH: "/workspace/replay-preview-canary.log",
};

const fixture = createReplayCanaryFixture("0123456789abcdef01234567");

function envelope(
  value: string,
  redactions: ReplayRedactionClass[] = [],
): ReplaySanitizedEnvelope {
  return {
    value,
    metadata: {
      redactions: Object.fromEntries(
        redactions.map((redaction) => [redaction, 1]),
      ),
      truncated: false,
      originalBytes: value.length,
      storedBytes: value.length,
      unavailable: false,
      unavailableReason: null,
    },
  };
}

function evidence(): ReplayCanaryEvidence {
  const attempt: WorkflowReplayAttemptDetail = {
    id: 41,
    nodeId: "agent",
    attempt: 1,
    activationScopeId: "root",
    state: "completed",
    outcome: { kind: "completed", status: "success" },
    selectedTransition: null,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    durationMs: 1,
    diagnosticId: null,
    input: envelope("sanitized", [
      "hard_exclusion",
      "token",
      "email",
      "phone",
      "payment_card",
      "iban",
    ]),
    output: envelope("safe"),
    logs: envelope("safe log tail"),
    metadata: null,
  };
  const summary: WorkflowRunReplayResponse = {
    availability: "available",
    mayAdvance: false,
    snapshot: {
      runId: "wrun_canary",
      definitionId: 7,
      definitionVersion: 2,
      definitionSchemaVersion: 2,
      graph: {
        nodes: [
          {
            id: "agent",
            type: "generic_agent",
            name: "Agent",
            x: 0,
            y: 0,
          },
        ],
        edges: [],
      },
      layout: { nodes: {}, edges: {} },
      runtimeManifest: envelope("safe manifest"),
      captureStatus: "available",
      capturedAt: new Date(0).toISOString(),
      expiresAt: new Date(2).toISOString(),
    },
    attempts: [
      {
        id: attempt.id,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
        activationScopeId: attempt.activationScopeId,
        state: attempt.state,
        outcome: attempt.outcome,
        selectedTransition: attempt.selectedTransition,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        durationMs: attempt.durationMs,
        diagnosticId: attempt.diagnosticId,
      },
    ],
    nextCursor: null,
  };
  return {
    runId: "wrun_canary",
    databaseRows: {
      observation: { run_id: "wrun_canary", runtime_manifest: envelope("safe") },
      attempts: [
        {
          id: 41,
          input_envelope: attempt.input,
          log_envelope: attempt.logs,
        },
      ],
    },
    apiSummary: summary,
    apiDetails: [attempt],
    appendedLogExport:
      '{"workflow_run_id":"wrun_canary","message":"completed"}',
  };
}

describe("Replay preview canary dry checks", () => {
  it("requires an absolute log path", () => {
    expect(parseReplayCanaryEnv(replayEnv)).toMatchObject({
      REPLAY_CANARY_LOG_WAIT_MS: 120_000,
      REPLAY_CANARY_LOG_SETTLE_MS: 15_000,
      REPLAY_CANARY_LOG_MAX_BYTES: 33_554_432,
    });
    expect(() =>
      parseReplayCanaryEnv({
        ...replayEnv,
        REPLAY_CANARY_LOG_EXPORT_PATH: "relative.log",
      }),
    ).toThrow();
  });

  it("builds a bounded fixture with all required sensitive-data classes", () => {
    expect(fixture.ticketDescription).toContain("token:");
    expect(fixture.ticketDescription).toContain("Authorization: Basic");
    expect(fixture.forbiddenValues.length).toBeGreaterThanOrEqual(10);
    expect(() => createReplayCanaryFixture("not-a-valid-nonce")).toThrow();
  });

  it("accepts complete sanitized DB, MCP trace, MCP logs, and export evidence", () => {
    expect(() =>
      assertReplayCanaryEvidence(evidence(), fixture),
    ).not.toThrow();
  });

  it.each([
    "database",
    "summary",
    "detail",
    "log",
  ] as const)("fails closed when the %s surface leaks a canary value", (surface) => {
    const candidate = evidence();
    const leaked = fixture.forbiddenValues[0]!;
    if (surface === "database") {
      candidate.databaseRows.observation = { leaked };
    } else if (surface === "summary") {
      candidate.apiSummary.attempts[0]!.outcome = {
        kind: "completed",
        status: leaked,
      };
    } else if (surface === "detail") {
      candidate.apiDetails[0]!.output = envelope(leaked);
    } else {
      candidate.appendedLogExport += leaked;
    }
    let message = "";
    try {
      assertReplayCanaryEvidence(candidate, fixture);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/contains a replay canary value/);
    expect(message).not.toContain(leaked);
  });

  it("requires API/DB log envelopes and run-scoped settled log evidence", () => {
    const noApiLog = evidence();
    noApiLog.apiDetails[0]!.logs = null;
    expect(() =>
      assertReplayCanaryEvidence(noApiLog, fixture),
    ).toThrow(/log envelope/);

    const noDbLog = evidence();
    (
      noDbLog.databaseRows.attempts[0] as Record<string, unknown>
    ).log_envelope = null;
    expect(() =>
      assertReplayCanaryEvidence(noDbLog, fixture),
    ).toThrow(/log envelope/);

    const unrelatedLogs = evidence();
    unrelatedLogs.appendedLogExport = '{"message":"another run"}';
    expect(() =>
      assertReplayCanaryEvidence(unrelatedLogs, fixture),
    ).toThrow(/does not prove coverage/);
  });

  it("requires redaction proof for every injected sensitive-data class", () => {
    const candidate = evidence();
    candidate.apiDetails[0]!.input = envelope("sanitized", ["token"]);
    expect(() =>
      assertReplayCanaryEvidence(candidate, fixture),
    ).toThrow(/expected hard_exclusion redaction/);
  });
});

const BASE_URL = "https://preview.example.test";
const BYPASS = "preview-bypass";
const CLIENT_ID = "engine-canary";
const CLIENT_SECRET = "machine-secret";

function jwt(scopes: readonly string[]): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ scope: scopes.join(" ") })}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("engine canary MCP machine credential", () => {
  it("discovers the token endpoint and sends the exact client_credentials request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ token_endpoint: `${BASE_URL}/api/auth/oauth2/token` }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: jwt(ENGINE_CANARY_MCP_SCOPES) }),
      );

    await expect(
      mintMcpAccessToken({
        baseUrl: BASE_URL,
        bypassSecret: BYPASS,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${BASE_URL}/.well-known/oauth-authorization-server/api/auth`,
    );
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "x-vercel-protection-bypass",
      ),
    ).toBe(BYPASS);

    const tokenCall = fetchMock.mock.calls[1]!;
    expect(tokenCall[0]).toBe(`${BASE_URL}/api/auth/oauth2/token`);
    const body = new URLSearchParams(String(tokenCall[1]?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "mcp:read runs:dispatch",
      resource: `${BASE_URL}/mcp`,
    });
  });

  it("fails closed when the access token carries a missing or extra scope", async () => {
    for (const scopes of [
      ["mcp:read"],
      ["mcp:read", "runs:dispatch", "tickets:write"],
    ]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ token_endpoint: `${BASE_URL}/api/auth/oauth2/token` }),
        )
        .mockResolvedValueOnce(jsonResponse({ access_token: jwt(scopes) }));

      await expect(
        mintMcpAccessToken({
          baseUrl: BASE_URL,
          bypassSecret: BYPASS,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          fetch: fetchMock,
        }),
      ).rejects.toThrow(/exact scopes/);
    }
  });

  it("reuses one token and retries one MCP request once after a 401", async () => {
    const firstToken = jwt(ENGINE_CANARY_MCP_SCOPES);
    const secondToken = jwt(ENGINE_CANARY_MCP_SCOPES);
    let discoveryCalls = 0;
    let tokenCalls = 0;
    let mcpCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes(".well-known/oauth-authorization-server")) {
        discoveryCalls += 1;
        return jsonResponse({ token_endpoint: `${BASE_URL}/api/auth/oauth2/token` });
      }
      if (url.endsWith("/oauth2/token")) {
        tokenCalls += 1;
        return jsonResponse({ access_token: tokenCalls === 1 ? firstToken : secondToken });
      }
      mcpCalls += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      if (mcpCalls === 1) return new Response(null, { status: 401 });
      return jsonResponse({ authorization });
    });
    const authorizedFetch = createMcpAuthorizedFetch({
      baseUrl: BASE_URL,
      bypassSecret: BYPASS,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchMock,
    });

    const response = await authorizedFetch(`${BASE_URL}/mcp`, { method: "POST" });
    expect(response.status).toBe(200);
    await authorizedFetch(`${BASE_URL}/mcp`, { method: "POST" });

    expect(discoveryCalls).toBe(2);
    expect(tokenCalls).toBe(2);
    expect(mcpCalls).toBe(3);
  });

  it("stops after the single retry when MCP returns a second 401", async () => {
    let tokenCalls = 0;
    let mcpCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes(".well-known/oauth-authorization-server")) {
        return jsonResponse({ token_endpoint: `${BASE_URL}/api/auth/oauth2/token` });
      }
      if (url.endsWith("/oauth2/token")) {
        tokenCalls += 1;
        return jsonResponse({ access_token: jwt(ENGINE_CANARY_MCP_SCOPES) });
      }
      mcpCalls += 1;
      return new Response(null, { status: 401 });
    });
    const authorizedFetch = createMcpAuthorizedFetch({
      baseUrl: BASE_URL,
      bypassSecret: BYPASS,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchMock,
    });

    const response = await authorizedFetch(`${BASE_URL}/mcp`, { method: "POST" });

    expect(response.status).toBe(401);
    expect(tokenCalls).toBe(2);
    expect(mcpCalls).toBe(2);
  });
});
