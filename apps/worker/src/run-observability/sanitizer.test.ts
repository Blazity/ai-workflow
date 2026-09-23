import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  appendReplayLogEnvelope,
  enforceReplayAttemptStorageBudget,
  REPLAY_FIELD_MAX_BYTES,
  replayAttemptEnvelopeBytes,
  sanitizeReplayGraphSnapshot,
  sanitizeReplayLayoutSnapshot,
  redactConfiguredSecretsInText,
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

  it("does not mistake a UUID's decimal-only segments for a phone number", () => {
    const uuid = "0b363504-6791-4963-9492-0cdea08acfe2";
    const envelope = sanitizeReplayValue({ approvalRequestId: uuid });
    expect(envelope.value).toEqual({ approvalRequestId: uuid });
    expect(envelope.metadata.redactions.phone).toBeUndefined();
  });

  it.each([
    "budget_exceeded: the run took 31 min 12 s, over the 30 min limit from " +
      "JOB_TIMEOUT_MS (this workflow sets no budgets.maxDurationMs). Raise " +
      "budgets.maxDurationMs on the workflow definition, or JOB_TIMEOUT_MS, to allow longer runs.",
    "budget_exceeded: the run took 48 min 3 s, over the 45 min limit from " +
      "budgets.maxDurationMs on this workflow definition. Raise budgets.maxDurationMs to allow longer runs.",
    "budget_exceeded: this invocation took 12 min 5 s, over the 10 min limit from " +
      "the harness profile \"Strict profile\" (runtimeLimits.maxDurationMs). " +
      "Raise that limit on the profile to allow longer invocations.",
  ])("keeps a duration budget message unchanged", (message) => {
    const envelope = sanitizeReplayValue(message);

    expect(envelope.value).toBe(message);
    expect(envelope.metadata.redactions.phone).toBeUndefined();
  });

  it("keeps a UUID intact when embedded in a JSON-ish sentence", () => {
    const uuid = "0b363504-6791-4963-9492-0cdea08acfe2";
    const envelope = sanitizeReplayValue(
      `run failed; "approvalRequestId": "${uuid}" needs review`,
    );
    expect(envelope.value).toBe(
      `run failed; "approvalRequestId": "${uuid}" needs review`,
    );
    expect(envelope.metadata.redactions.phone).toBeUndefined();
  });

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

  it("keeps replay payloads with undefined optional object fields", () => {
    const envelope = sanitizeReplayValue({
      decision: "request_changes",
      feedback: undefined,
      findings: [
        {
          file: "src/index.ts",
          description: "Handle this case.",
          startLine: undefined,
          endLine: undefined,
        },
      ],
    });

    expect(envelope.metadata.unavailable).toBe(false);
    expect(envelope.value).toEqual({
      decision: "request_changes",
      findings: [
        {
          file: "src/index.ts",
          description: "Handle this case.",
        },
      ],
    });
  });

  it("keeps JSON-shaped values created in another JavaScript realm", () => {
    const value = runInNewContext(
      `({
        status: "ok",
        check: {
          id: "check_123",
          headSha: "abc123",
          name: "AI Workflow / Review"
        }
      })`,
    );

    const envelope = sanitizeReplayValue(value);

    expect(envelope.metadata.unavailable).toBe(false);
    expect(envelope.value).toEqual({
      status: "ok",
      check: {
        id: "check_123",
        headSha: "abc123",
        name: "AI Workflow / Review",
      },
    });
  });

  it("still rejects class instances created in another JavaScript realm", () => {
    const value = runInNewContext(
      `new (class WorkflowValue {
        constructor() {
          this.status = "ok";
        }
      })()`,
    );

    expect(sanitizeReplayValue(value).metadata.unavailableReason).toBe(
      "serialization",
    );
  });

  it("rejects a spoofed Object constructor without reading its name", () => {
    let nameAccessed = false;
    const constructor = function WorkflowValue() {};
    Object.defineProperty(constructor, "name", {
      configurable: true,
      get() {
        nameAccessed = true;
        return "Object";
      },
    });
    const prototype = Object.create(null);
    Object.defineProperty(prototype, "constructor", {
      value: constructor,
    });
    const value = Object.assign(Object.create(prototype), { status: "ok" });

    expect(sanitizeReplayValue(value).metadata.unavailableReason).toBe(
      "serialization",
    );
    expect(nameAccessed).toBe(false);
  });

  it("rejects accessor properties without invoking them", () => {
    let accessed = false;
    const value = {};
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get() {
        accessed = true;
        return "must-not-be-read";
      },
    });

    expect(sanitizeReplayValue(value).metadata.unavailableReason).toBe(
      "serialization",
    );
    expect(accessed).toBe(false);
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

describe("configured secrets in the run log", () => {
  const PEM = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAx7Qk9mZyJ4pQ0m1nZ9wP",
    "q8R2s3T4u5V6w7X8y9Z0a1B2c3D4e5F6g7H8",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const PEM_LINE = "q8R2s3T4u5V6w7X8y9Z0a1B2c3D4e5F6g7H8";
  it("takes out a PEM key written JSON-escaped and one line of it, as every redactor does", () => {
    const escaped = redactConfiguredSecretsInText(`{"key":"${JSON.stringify(PEM).slice(1, -1)}"}`, [PEM]);
    expect(escaped).not.toContain(PEM_LINE);
    const quoted = redactConfiguredSecretsInText(`bad line ${PEM_LINE}`, [PEM]);
    expect(quoted).not.toContain(PEM_LINE);
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

/**
 * The phone rule against the numbers a run really logs.
 *
 * Production served a cost as `0.[REDACTED:phone]` and a harness manifest's
 * `"maxTokens":"[REDACTED:token]"` through runs.logs
 * (wrun_01M2WCQ37TMM2RR4D55HPY4MD7). Every literal below is one of those real
 * false positives, or a real phone number that must still go.
 */
describe("sanitizeReplayValue: numbers that are not phone numbers", () => {
  // Red when: the phone rule matches a bare digit run, a decimal, a date, a
  // time, an IP address or a model's date suffix again.
  it.each([
    ["a cost", "cost 0.0512345 USD"],
    ["a model with a date suffix", "model claude-sonnet-4-5-20250929 answered"],
    ["another model with a date suffix", "model gpt-4o-2024-08-06 answered"],
    ["a date", "released on 2026-09-01"],
    ["a timestamp", "started 2026-09-19 12:34 UTC"],
    ["an IP address", "connected to 192.168.10.20"],
    ["a decimal", "ratio 123.4567"],
    ["epoch milliseconds", "at 1726750000000"],
    ["a token budget in text", "maxTokens: 200000"],
    ["a day-first date with dots", "due 19.09.2026"],
    ["a day-first date with hyphens", "due 19-09-2026"],
    ["a workflow run id in a path", "see actions/runs/11234567890 for the log"],
    ["epoch seconds", "at 1726750000"],
    ["an older model with a date suffix", "model claude-3-5-sonnet-20241022 answered"],
    ["a dotted build number", "build 2026.09.19.1 deployed"],
    // These three pass the card checksum, and the card rule runs before the
    // phone rule, so they would come back as payment cards instead.
    ["epoch milliseconds that pass the card checksum (1)", "at 1726750000001"],
    ["epoch milliseconds that pass the card checksum (2)", "at 1726750000019"],
    ["epoch milliseconds that pass the card checksum (3)", "at 1726750000027"],
  ])("keeps %s", (_label, text) => {
    const envelope = sanitizeReplayValue(text);
    expect(envelope.value).toBe(text);
    expect(envelope.metadata.redactions).toEqual({});
  });

  // Red when: the fix for the false positives above loses a real number.
  it.each([
    ["an international number with spaces", "call +48 601 234 567 today", "+48 601 234 567"],
    ["a US number with an area code in parentheses", "call (415) 555-2671 today", "(415) 555-2671"],
    ["an international number with hyphens", "call +1-202-555-0143 today", "+1-202-555-0143"],
    ["a local number with hyphens", "call 601-234-567 today", "601-234-567"],
    ["a local number with spaces", "call 601 234 567 today", "601 234 567"],
    ["an international number written without spaces", "call +48601234567 today", "+48601234567"],
    ["an international number with a 00 prefix", "call 0048 601 234 567 today", "0048 601 234 567"],
  ])("still redacts %s", (_label, text, number) => {
    const envelope = sanitizeReplayValue(text);
    expect(envelope.value).toBe(text.replace(number, "[REDACTED:phone]"));
    expect(envelope.metadata.redactions.phone).toBe(1);
  });
});

describe("sanitizeReplayValue: fields named after tokens", () => {
  // Red when: a count whose name merely contains "token" is replaced by a
  // redaction marker, as production served a harness manifest.
  it("keeps the value of a token count field", () => {
    const manifest = {
      maxTokens: 200000,
      maxOutputTokens: "64000",
      tokensInput: 1234,
      tokenCount: 42,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadInputTokens: 5 },
    };
    const envelope = sanitizeReplayValue(manifest);
    expect(envelope.value).toEqual(manifest);
    expect(envelope.metadata.redactions.token).toBeUndefined();
  });

  // Red when: a limit that is not set (`maxTokens: null`, as the model catalog
  // writes it) is shown as a redacted credential. Production served a harness
  // manifest's `limits.maxTokens` as "[REDACTED:token]" through runs.logs.
  it("keeps a token-named field whose value holds nothing", () => {
    const manifest = { limits: { maxTokens: null, maxOutputTokens: 64000 }, token: null, useToken: false };
    const envelope = sanitizeReplayValue(manifest);
    expect(envelope.value).toEqual(manifest);
    expect(envelope.metadata.redactions.token).toBeUndefined();
  });

  // Red when: the count exemption lets a credential through, by its name or
  // by a value that is not a count.
  it("still redacts fields that hold a credential", () => {
    const credentials = {
      token: "opaque-credential-1",
      accessToken: "opaque-credential-2",
      access_token: "opaque-credential-3",
      refresh_token: "opaque-credential-4",
      id_token: "opaque-credential-5",
      apiToken: "opaque-credential-6",
      GITHUB_TOKEN: "opaque-credential-7",
      "x-auth-token": "opaque-credential-8",
      oauthToken: "opaque-credential-9",
      apiTokens: ["opaque-credential-10"],
      refreshToken: 12345678,
      maxTokens: "opaque-credential-11",
    };
    const envelope = sanitizeReplayValue(credentials);
    const text = serialized(envelope);
    for (let index = 1; index <= 11; index += 1) {
      expect(text).not.toContain(`opaque-credential-${index}"`);
    }
    expect(text).not.toContain("12345678");
    expect(envelope.metadata.redactions.token).toBe(Object.keys(credentials).length);
  });
});

describe("sanitizeReplayValue: an address inside escaped JSON", () => {
  // Red when: the letter of an escape (`\n`) is read as the local part of an
  // email address. A pytest marker on its own line inside an agent's JSON
  // output came back as "\[REDACTED:email].unit_tests".
  it("keeps a decorator that follows an escaped newline", () => {
    const text = '{"patch":"import pytest\\n@pytest.mark.unit_tests\\ndef test_x(): pass"}';
    const envelope = sanitizeReplayValue(text);
    expect(envelope.value).toBe(text);
    expect(envelope.metadata.redactions.email).toBeUndefined();
  });

  it("still redacts an address that follows an escaped newline", () => {
    const text = '{"body":"Contact\\nalice@example.com\\nthanks"}';
    const envelope = sanitizeReplayValue(text);
    expect(envelope.value).toBe('{"body":"Contact\\n[REDACTED:email]\\nthanks"}');
    expect(envelope.metadata.redactions.email).toBe(1);
  });
});
