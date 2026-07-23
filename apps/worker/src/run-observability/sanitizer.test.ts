import { describe, expect, it } from "vitest";
import {
  appendReplayLogEnvelope,
  enforceReplayAttemptStorageBudget,
  REPLAY_FIELD_MAX_BYTES,
  replayAttemptEnvelopeBytes,
  sanitizeReplayGraphSnapshot,
  sanitizeReplayLayoutSnapshot,
  sanitizeReplayValue,
} from "./sanitizer.js";

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("sanitizeReplayValue", () => {
  it("hard-excludes headers, cookies, environments, and authentication files", () => {
    const envelope = sanitizeReplayValue({
      headers: {
        authorization: "Bearer must-not-survive",
        cookie: "session=must-not-survive",
        accept: "application/json",
      },
      env: { API_KEY: "must-not-survive" },
      cookies: { session: "must-not-survive" },
      cookieJar: { session: "must-not-survive" },
      envVars: { DB_PASS: "must-not-survive" },
      processEnv: { DB_PASS: "must-not-survive" },
      environmentVariables: { DB_PASS: "must-not-survive" },
      auth: {
        path: "/home/agent/.codex/auth.json",
        content: "must-not-survive",
      },
      dockerAuth: {
        file: "/home/agent/.docker/config.json",
        content: {
          auths: { "registry.example.com": "must-not-survive" },
        },
      },
      claudeAuth: {
        filePath: "/home/agent/.claude/.credentials.json",
        content: "must-not-survive",
      },
      alternateClaudeAuth: {
        file_path: "/home/agent/.claude/.credentials.json",
        content: "must-not-survive",
      },
    });
    const text = serialized(envelope);
    expect(text).not.toContain("must-not-survive");
    expect(text).toContain("[REDACTED:hard_exclusion]");
    expect(envelope.metadata.redactions.hard_exclusion).toBe(12);
  });

  it("hard-excludes raw authentication and cookie header lines", () => {
    const envelope = sanitizeReplayValue(
      "Authorization: Basic dXNlcjpwYXNz\n> Cookie: session=must-not-survive\nrequest headers: Authorization: Basic inline-secret\nAccept: application/json",
    );
    expect(envelope.value).toBe(
      "Authorization: [REDACTED:hard_exclusion]\n> Cookie: [REDACTED:hard_exclusion]\nrequest headers: Authorization: [REDACTED:hard_exclusion]\nAccept: application/json",
    );
    expect(envelope.metadata.redactions.hard_exclusion).toBe(3);
  });

  it("sanitizes sensitive object property names and fails closed on collisions", () => {
    const envelope = sanitizeReplayValue(
      {
        "person@example.com": "safe",
        "configured-secret-key": "safe",
      },
      { secrets: ["configured-secret-key"] },
    );
    const text = serialized(envelope);
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("configured-secret-key");
    expect(text).toContain("[REDACTED:email]");
    expect(text).toContain("[REDACTED:configured_secret]");

    const collision = sanitizeReplayValue({
      "first@example.com": "one",
      "second@example.com": "two",
    });
    expect(collision.metadata).toMatchObject({
      unavailable: true,
      unavailableReason: "serialization",
    });
  });

  it.each([
    [
      "configured secret",
      "prefix configured-secret-value suffix",
      ["configured-secret-value"],
      "configured_secret",
    ],
    [
      "API token",
      "sk-1234567890abcdefghijklmnop",
      [],
      "token",
    ],
    [
      "JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      [],
      "jwt",
    ],
    [
      "private key",
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
      [],
      "private_key",
    ],
    [
      "credential URL",
      "postgres://admin:password@example.com/database",
      [],
      "credential_url",
    ],
    ["email", "reach me at person@example.com", [], "email"],
    ["phone", "call +48 600 123 456 today", [], "phone"],
    ["payment card", "4242 4242 4242 4242", [], "payment_card"],
    ["IBAN", "GB82 WEST 1234 5698 7654 32", [], "iban"],
    ["payment identifier", "pi_1234567890abcdef", [], "payment_identifier"],
  ] as const)(
    "redacts %s recursively",
    (_label, value, secrets, expectedClass) => {
      const envelope = sanitizeReplayValue({ nested: [{ value }] }, { secrets });
      expect(serialized(envelope)).not.toContain(value);
      expect(envelope.metadata.redactions[expectedClass]).toBeGreaterThan(0);
    },
  );

  it("does not rescan redaction markers when a short secret occurs inside one", () => {
    const envelope = sanitizeReplayValue("secret configured secret", {
      secrets: ["secret", "configured"],
    });
    expect(envelope.value).toBe(
      "[REDACTED:configured_secret] [REDACTED:configured_secret] [REDACTED:configured_secret]",
    );
    expect(envelope.metadata.redactions.configured_secret).toBe(3);
  });

  it("redacts credential-bearing command arguments without hiding safe arguments", () => {
    const envelope = sanitizeReplayValue({
      argv: [
        "deploy",
        "--token",
        "raw-token",
        "--client-secret=raw-client-secret",
        "-u",
        "alice:swordfish",
        "--user=bob:hunter2",
        "-H",
        "X-API-Key: raw-header-key",
        "--header=Accept: application/json",
        "--cookie",
        "session=raw-cookie",
        "--proxy-user=proxy:raw-proxy-password",
        "--oauth2-bearer",
        "raw-oauth-bearer",
        "-b",
        "session=raw-short-cookie",
        "-braw-attached-cookie",
        "https://url-token@example.com/private",
        "SAFE=value",
        "API_KEY=raw-api-key",
      ],
      command:
        "curl -u command:password -uattached:password -H 'Authorization: Bearer raw-header' -HAuthorization: Basic attached-header --password raw-password --cookie raw-command-cookie --proxy-user=proxy:raw-command-proxy --oauth2-bearer raw-command-oauth -b raw-command-short-cookie -braw-command-attached-cookie --region eu-west-1 ACCESS_TOKEN=raw-access https://command-token@example.com/private",
    });
    const text = serialized(envelope);
    for (const secret of [
      "raw-token",
      "raw-client-secret",
      "alice:swordfish",
      "bob:hunter2",
      "raw-header-key",
      "raw-cookie",
      "raw-proxy-password",
      "raw-oauth-bearer",
      "raw-short-cookie",
      "raw-attached-cookie",
      "url-token",
      "command:password",
      "attached:password",
      "raw-header",
      "attached-header",
      "command-token",
      "raw-api-key",
      "raw-password",
      "raw-command-cookie",
      "raw-command-proxy",
      "raw-command-oauth",
      "raw-command-short-cookie",
      "raw-command-attached-cookie",
      "raw-access",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("Accept: application/json");
    expect(text).toContain("SAFE=value");
    expect(text).toContain("eu-west-1");
    expect(envelope.metadata.redactions.command_argument).toBeGreaterThanOrEqual(
      11,
    );
    expect(envelope.metadata.redactions.credential_url).toBe(2);
  });

  it("redacts credential-bearing commands embedded in diagnostic log text", () => {
    const envelope = sanitizeReplayValue({
      stream: "stderr",
      tail:
        "curl -u alice:hunter2 -H 'Authorization: Bearer log-secret' https://url-secret@example.com/private",
    });
    const text = serialized(envelope);
    expect(text).not.toContain("alice:hunter2");
    expect(text).not.toContain("log-secret");
    expect(text).not.toContain("url-secret");
    expect(envelope.metadata.redactions.command_argument).toBe(2);
    expect(envelope.metadata.redactions.credential_url).toBe(1);
  });

  it("fails closed with deterministic unavailable markers for unsafe structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const first = sanitizeReplayValue(circular);
    const second = sanitizeReplayValue(circular);
    expect(first).toEqual(second);
    expect(first.metadata).toMatchObject({
      unavailable: true,
      unavailableReason: "traversal_limit",
    });
    expect(first.value).toEqual({
      $replay: "unavailable",
      reason: "traversal_limit",
    });

    expect(sanitizeReplayValue(1n).metadata.unavailableReason).toBe(
      "serialization",
    );
    expect(
      sanitizeReplayValue({ nested: { value: true } }, { maxDepth: 1 })
        .metadata.unavailableReason,
    ).toBe("traversal_limit");
    expect(
      sanitizeReplayValue([1, 2, 3], { maxNodes: 2 }).metadata
        .unavailableReason,
    ).toBe("traversal_limit");
    expect(
      sanitizeReplayValue(Buffer.from([0xff, 0xfe])).metadata
        .unavailableReason,
    ).toBe("serialization");
  });

  it("caps fields at 64 KiB without splitting Unicode code points", () => {
    const envelope = sanitizeReplayValue("🦊".repeat(40_000));
    expect(Buffer.byteLength(serialized(envelope), "utf8")).toBeLessThanOrEqual(
      REPLAY_FIELD_MAX_BYTES,
    );
    expect(envelope.metadata.truncated).toBe(true);
    expect(envelope.value).not.toContain("�");
  });

  it("fails closed before cloning or scanning an oversized structure", () => {
    const repeated = "x".repeat(64 * 1024);
    const envelope = sanitizeReplayValue(
      Array.from({ length: 10_000 }, () => repeated),
    );
    expect(envelope.metadata).toMatchObject({
      unavailable: true,
      unavailableReason: "size_limit",
    });
    expect(envelope.value).toEqual({
      $replay: "unavailable",
      reason: "size_limit",
    });
  });

  it("redacts user-authored replay graph labels", () => {
    const graph = sanitizeReplayGraphSnapshot({
      nodes: [
        {
          id: "agent",
          type: "generic_agent",
          name: "Contact person@example.com with configured-value",
          x: 0,
          y: 0,
        },
      ],
      edges: [],
    }, ["configured-value"]);
    expect(graph?.nodes[0]?.name).not.toContain("person@example.com");
    expect(graph?.nodes[0]?.name).not.toContain("configured-value");
    expect(graph?.nodes[0]?.name).toContain("[REDACTED:email]");
  });

  it("makes redaction markers idempotent for short configured secrets", () => {
    const first = sanitizeReplayValue("secret", {
      secrets: ["secret"],
    });
    const second = sanitizeReplayValue(first.value, {
      secrets: ["secret"],
    });
    expect(second.value).toBe(first.value);
  });

  it("rejects oversized or unsafe replay graph snapshots before persistence", () => {
    expect(
      sanitizeReplayGraphSnapshot({
        nodes: [
          {
            id: "x".repeat(201),
            type: "generic_agent",
            name: null,
            x: 0,
            y: 0,
          },
        ],
        edges: [],
      }),
    ).toBeNull();

    expect(
      sanitizeReplayGraphSnapshot({
        nodes: Array.from({ length: 200 }, (_, index) => ({
          id: `node-${index}`,
          type: "generic_agent" as const,
          name: "n".repeat(4096),
          x: index,
          y: 0,
        })),
        edges: [],
      }),
    ).toBeNull();
  });

  it("rejects sensitive identifiers instead of breaking replay references", () => {
    expect(
      sanitizeReplayGraphSnapshot(
        {
          nodes: [
            {
              id: "configured-node-secret",
              type: "generic_agent",
              name: null,
              x: 0,
              y: 0,
            },
          ],
          edges: [],
        },
        ["configured-node-secret"],
      ),
    ).toBeNull();
    expect(
      sanitizeReplayGraphSnapshot({
        nodes: [
          {
            id: "safe-node",
            type: "generic_agent",
            name: null,
            x: 0,
            y: 0,
          },
        ],
        edges: [
          {
            id: "pi_1234567890abcdef",
            from: "safe-node",
            to: "safe-node",
            fromPort: "out",
          },
        ],
      }),
    ).toBeNull();
    expect(
      sanitizeReplayLayoutSnapshot(
        {
          nodes: {
            "sk-abcdefghijklmnop": { x: 0, y: 0 },
          },
        },
      ),
    ).toBeNull();
  });
});

describe("attempt envelope budgets", () => {
  it("keeps the newest log tail while bounding repeated log events", () => {
    const first = sanitizeReplayValue(`old:${"a".repeat(60_000)}`, {
      retain: "tail",
    });
    const next = sanitizeReplayValue(`new:${"b".repeat(60_000)}`, {
      retain: "tail",
    });
    const logs = appendReplayLogEnvelope(first, next);
    expect(Buffer.byteLength(serialized(logs), "utf8")).toBeLessThanOrEqual(
      REPLAY_FIELD_MAX_BYTES,
    );
    expect(logs.metadata.truncated).toBe(true);
    expect(serialized(logs)).toContain("new:");
    expect(serialized(logs)).not.toContain("old:");
  });

  it("enforces 256 KiB total by reducing logs before input and output", () => {
    const input = sanitizeReplayValue(`input:${"i".repeat(80_000)}`);
    const output = sanitizeReplayValue(`output:${"o".repeat(80_000)}`);
    const logs = sanitizeReplayValue(`logs:${"l".repeat(80_000)}`, {
      retain: "tail",
    });
    const metadata = sanitizeReplayValue(`metadata:${"m".repeat(80_000)}`);
    const reducedBudget = 200 * 1024;
    const bounded = enforceReplayAttemptStorageBudget(
      {
        input,
        output,
        logs,
        metadata,
      },
      reducedBudget,
    );
    expect(replayAttemptEnvelopeBytes(bounded)).toBeLessThanOrEqual(
      reducedBudget,
    );
    expect(serialized(bounded.logs)).not.toEqual(serialized(logs));
    expect(bounded.input).toEqual(input);
    expect(bounded.output).toEqual(output);
  });
});
