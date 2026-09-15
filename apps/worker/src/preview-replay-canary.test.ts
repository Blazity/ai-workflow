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
  parseReplayCanaryLogLines,
  scanReplayCanaryLogRows,
  type ReplayCanaryEvidence,
} from "../e2e/replay/canary-contract.js";
import {
  createMcpAuthorizedFetch,
  ENGINE_CANARY_MCP_SCOPES,
  mintMcpAccessToken,
} from "../e2e/harness-profiles/mcp-machine-credential.js";

const replayEnv = {
  ENGINE_CANARY_LOG_SOURCE_URL:
    "https://ai-workflow-app-abc123def-blazity.vercel.app",
  VERCEL_TOKEN: "vercel-token",
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
    runLogs: {
      availability: "available",
      manifest: envelope("safe manifest"),
      manifestTruncated: false,
      attempts: [{ id: attempt.id }],
    },
    apiSummary: summary,
    apiDetails: [attempt],
    appendedLogExport: '{"msg":"workflow_step_completed"}',
  };
}

const RUN_WINDOW = { startedAt: 1_000_000, endedAt: 1_060_000 };

function logLine(row: unknown): string {
  return JSON.stringify(row);
}

describe("Replay preview canary dry checks", () => {
  it("requires an HTTPS log source and a token", () => {
    expect(parseReplayCanaryEnv(replayEnv)).toMatchObject({
      REPLAY_CANARY_LOG_WAIT_MS: 120_000,
      REPLAY_CANARY_LOG_MAX_BYTES: 33_554_432,
    });
    expect(() =>
      parseReplayCanaryEnv({
        ...replayEnv,
        ENGINE_CANARY_LOG_SOURCE_URL: "http://preview.example.test",
      }),
    ).toThrow();
    expect(() =>
      parseReplayCanaryEnv({ ...replayEnv, VERCEL_TOKEN: "" }),
    ).toThrow();
  });

  it("builds a bounded fixture with all required sensitive-data classes", () => {
    expect(fixture.ticketDescription).toContain("token:");
    expect(fixture.ticketDescription).toContain("Authorization: Basic");
    expect(fixture.forbiddenValues.length).toBeGreaterThanOrEqual(10);
    expect(() => createReplayCanaryFixture("not-a-valid-nonce")).toThrow();
  });

  it("accepts complete sanitized MCP run logs, MCP trace, MCP attempt logs, and export evidence", () => {
    expect(() =>
      assertReplayCanaryEvidence(evidence(), fixture),
    ).not.toThrow();
  });

  it.each([
    "run logs",
    "summary",
    "detail",
    "log",
  ] as const)("fails closed when the %s surface leaks a canary value", (surface) => {
    const candidate = evidence();
    const leaked = fixture.forbiddenValues[0]!;
    if (surface === "run logs") {
      candidate.runLogs.manifest = envelope(leaked);
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

  it("requires an attempt log envelope over the replay API", () => {
    const noApiLog = evidence();
    noApiLog.apiDetails[0]!.logs = null;
    expect(() =>
      assertReplayCanaryEvidence(noApiLog, fixture),
    ).toThrow(/log envelope/);
  });

  // The run level runs.logs reply is the second surface the database rows used
  // to be: the captured runtime manifest (the observation row) and the index of
  // attempts (the attempt rows), read through the product instead of SQL.
  it("requires the run logs reply to hold the capture the trace describes", () => {
    const unavailable = evidence();
    unavailable.runLogs.availability = "expired";
    expect(() => assertReplayCanaryEvidence(unavailable, fixture)).toThrow(
      /run logs did not report an available capture/,
    );

    const noManifest = evidence();
    noManifest.runLogs.manifest = null;
    expect(() => assertReplayCanaryEvidence(noManifest, fixture)).toThrow(
      /run logs did not return the runtime manifest/,
    );

    const truncatedManifest = evidence();
    truncatedManifest.runLogs.manifestTruncated = true;
    expect(() =>
      assertReplayCanaryEvidence(truncatedManifest, fixture),
    ).toThrow(/run logs did not return the runtime manifest/);

    const otherAttempts = evidence();
    otherAttempts.runLogs.attempts = [{ id: 41 }, { id: 42 }];
    expect(() => assertReplayCanaryEvidence(otherAttempts, fixture)).toThrow(
      /run logs attempt index \[41,42\] does not match the trace \[41\]/,
    );
  });

  it("requires redaction proof for every injected sensitive-data class", () => {
    const candidate = evidence();
    candidate.apiDetails[0]!.input = envelope("sanitized", ["token"]);
    expect(() =>
      assertReplayCanaryEvidence(candidate, fixture),
    ).toThrow(/expected hard_exclusion redaction/);
  });
});

describe("Replay canary runtime log query", () => {
  it("keeps only JSON object rows that carry a timestamp", () => {
    const output = [
      "Fetching logs...",
      "waiting for new logs...",
      "{ not json",
      logLine([1, 2, 3]),
      logLine({ requestPath: "/mcp", message: "no timestamp" }),
      logLine({
        timestamp: RUN_WINDOW.startedAt + 1_000,
        requestPath: "/mcp",
        message: "kept",
      }),
      "",
    ].join("\n");

    expect(parseReplayCanaryLogLines(output)).toEqual([
      {
        timestampMs: RUN_WINDOW.startedAt + 1_000,
        requestPath: "/mcp",
        text: "kept",
      },
    ]);
  });

  it("accepts an ISO timestamp as well as epoch milliseconds", () => {
    const iso = new Date(RUN_WINDOW.startedAt + 500).toISOString();
    expect(
      parseReplayCanaryLogLines(
        logLine({ timestamp: iso, requestPath: "/mcp", message: "" }),
      ),
    ).toEqual([
      {
        timestampMs: RUN_WINDOW.startedAt + 500,
        requestPath: "/mcp",
        text: "",
      },
    ]);
  });

  it("proves coverage only from a step or flow row inside the window", () => {
    const stepRow = {
      timestamp: RUN_WINDOW.startedAt + 5_000,
      requestPath: "/.well-known/workflow/v1/step",
      message: "",
    };
    const flowRow = {
      ...stepRow,
      requestPath: "/.well-known/workflow/v1/flow",
    };

    for (const covering of [stepRow, flowRow]) {
      expect(
        scanReplayCanaryLogRows(
          parseReplayCanaryLogLines(logLine(covering)),
          RUN_WINDOW,
        ).covered,
      ).toBe(true);
    }

    const outsideWindow = parseReplayCanaryLogLines(
      [
        logLine({ ...stepRow, timestamp: RUN_WINDOW.startedAt - 1 }),
        logLine({ ...stepRow, timestamp: RUN_WINDOW.endedAt + 1 }),
      ].join("\n"),
    );
    expect(scanReplayCanaryLogRows(outsideWindow, RUN_WINDOW)).toMatchObject({
      covered: false,
      rowCount: 0,
    });

    const unrelatedPath = parseReplayCanaryLogLines(
      logLine({ ...stepRow, requestPath: "/mcp" }),
    );
    expect(scanReplayCanaryLogRows(unrelatedPath, RUN_WINDOW)).toMatchObject({
      covered: false,
      rowCount: 1,
    });
  });

  it("reports an empty leak scan when the covered rows carry no runtime text", () => {
    const rows = parseReplayCanaryLogLines(
      [
        logLine({
          timestamp: RUN_WINDOW.startedAt + 1_000,
          requestPath: "/.well-known/workflow/v1/step",
          message: "",
          logs: [],
        }),
        logLine({
          timestamp: RUN_WINDOW.startedAt + 2_000,
          requestPath: "/.well-known/workflow/v1/flow",
          message: "",
        }),
      ].join("\n"),
    );

    expect(scanReplayCanaryLogRows(rows, RUN_WINDOW)).toEqual({
      covered: true,
      rowCount: 2,
      coveredRows: 2,
      logText: "",
      logTextBytes: 0,
    });
  });

  it("scans every runtime line of an in-window row for a leaked value", () => {
    const leaked = fixture.forbiddenValues[0]!;
    const rows = parseReplayCanaryLogLines(
      [
        logLine({
          timestamp: RUN_WINDOW.startedAt + 1_000,
          requestPath: "/.well-known/workflow/v1/step",
          message: "first line",
          logs: [
            { message: "first line" },
            { message: `second line ${leaked}` },
          ],
        }),
        logLine({
          timestamp: RUN_WINDOW.endedAt + 60_000,
          requestPath: "/mcp",
          message: "after the window",
        }),
      ].join("\n"),
    );
    const scan = scanReplayCanaryLogRows(rows, RUN_WINDOW);

    expect(scan.covered).toBe(true);
    expect(scan.rowCount).toBe(1);
    expect(scan.logText).toBe(`first line\nsecond line ${leaked}`);
    expect(scan.logText).not.toContain("after the window");

    const candidate = evidence();
    candidate.appendedLogExport = scan.logText;
    expect(() => assertReplayCanaryEvidence(candidate, fixture)).toThrow(
      /Application log export contains a replay canary value/,
    );
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
