/**
 * What the webhook route is handed for Slack's slash command, through the real
 * resolver, the real settings snapshot, the real registry and Slack's own
 * `receive`. Only the two database reads are replaced: the integration
 * connection rows and the settings rows.
 *
 * Two promises are held here, both of them `main`'s behaviour:
 *
 * - The command needs only what it uses. On `main` a deployment that
 *   registered the command with `SLACK_SIGNING_SECRET` alone answered it; the
 *   answer goes to Slack's `response_url` and needs no bot token.
 * - Who may run it is an operator setting, not a connection value. It reads
 *   `SLACK_ALLOWED_USER_IDS` as `main` did while nothing is stored, a stored
 *   value shadows the variable, and switching the connection's source leaves
 *   it where it was.
 */
import { createHmac } from "node:crypto";
import type { IntegrationWebhookReception } from "@integrations/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredIntegrationConnection } from "../../db/repositories/integrations.js";
import { encryptIntegrationSecret } from "../../infra/secrets-crypto.js";

const state = vi.hoisted(() => ({
  connections: new Map<string, unknown>(),
  settingsRows: [] as { key: string; value: unknown }[],
  failReads: 0,
}));

vi.mock("../../db/repositories/integrations.js", () => ({
  readConnectedIntegrationConnections: async () => {
    if (state.failReads > 0) {
      state.failReads -= 1;
      throw new Error("connection reset");
    }
    return state.connections;
  },
}));
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: async () => state.settingsRows,
  readAllSettings: async () => state.settingsRows,
}));
// The parsed environment is core's own and not what is under test; a variable
// it does not declare (every integration setting's) is read off process.env.
vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));
// Which database this deployment writes to, for the card's write access.
vi.mock("../../db/repositories/system-health.js", () => ({
  readConnectedDeploymentEnvironmentMarker: async () => null,
}));

const { resolveUsableIntegrations } = await import("./usable.js");
const { integrationSecretDigest } = await import("./resolve.js");
const { loadSettingsSnapshot } = await import("../settings/snapshot.js");
const { listIntegrations } = await import("./authoring.js");

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const SECRETS_KEY = "a".repeat(64);
/** The user every request below comes from. */
const CALLER = "U2147483697";

beforeEach(() => {
  state.connections = new Map();
  state.settingsRows = [];
  state.failReads = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Exactly what the route does: resolve Slack for its webhook, with the settings of this request. */
async function slackForWebhook(settings: () => Promise<Readonly<Record<string, unknown>>> = loadSettingsSnapshot) {
  const resolved = await resolveUsableIntegrations({
    filter: (manifest) => manifest.id === "slack",
    forWebhook: { settings },
  });
  if (!resolved.readable) return { readable: false as const, reason: resolved.reason };
  return {
    readable: true as const,
    slack: resolved.usable.find((candidate) => candidate.manifest.id === "slack") ?? null,
  };
}

/** A signed `/ai-workflow <text>` from CALLER, at the current time. */
function command(text: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = new URLSearchParams({
    command: "/ai-workflow",
    text,
    user_id: CALLER,
    response_url: "https://hooks.slack.com/commands/T0001/1/abc",
  }).toString();
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return {
    method: "POST",
    rawBody,
    headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
    query: {},
  };
}

async function receive(
  slack: NonNullable<Extract<Awaited<ReturnType<typeof slackForWebhook>>, { readable: true }>["slack"]>,
  text: string,
): Promise<IntegrationWebhookReception> {
  // The erased runtime takes its arguments as `never`, as the route calls it.
  return (await slack.runtime.webhook!.receive(
    command(text) as never,
    slack.ctx as never,
  )) as IntegrationWebhookReception;
}

/** Slack stored from the dashboard: token, channel and secret, and no allowlist. */
function storedSlack(): StoredIntegrationConnection {
  const secret = (fieldKey: string, value: string) =>
    encryptIntegrationSecret(value, SECRETS_KEY, { integrationId: "slack", fieldKey });
  return {
    enabled: true,
    source: "stored",
    latestVersion: 1,
    activeVersion: 1,
    active: {
      version: 1,
      config: { channelId: "C0STORED" },
      secrets: { botToken: secret("botToken", "xoxb-stored"), signingSecret: secret("signingSecret", SIGNING_SECRET) },
      secretDigests: {
        botToken: integrationSecretDigest("slack", "botToken", "xoxb-stored"),
        signingSecret: integrationSecretDigest("slack", "signingSecret", SIGNING_SECRET),
      },
      testStatus: "passed",
      testReason: null,
      testMessage: null,
      testedAt: "2026-09-22T10:00:00.000Z",
      createdAt: "2026-09-22T10:00:00.000Z",
    },
    latest: null,
    lastTest: null,
  };
}

describe("the slash command needs only what it uses", () => {
  it("verifies and answers with nothing but the signing secret set", async () => {
    // A deployment that registered the command and nothing else: no bot token
    // and no channel, so Slack itself is not Connected. On main it answered.
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);

    const resolved = await slackForWebhook();

    expect(resolved.readable).toBe(true);
    if (!resolved.readable || !resolved.slack) throw new Error("Slack was not served");
    // Exactly what the webhook declared it reads, and nothing it did not.
    expect(resolved.slack.ctx.connection).toEqual({ signingSecret: SIGNING_SECRET });
    const reception = await receive(resolved.slack, "cancel AWT-42");
    expect(reception.kind).toBe("run_control");
  });

  it("rides out a blink of the database, on the same retry rule as the secret set", async () => {
    // One failed read of the connections used to answer 503 at once, while the
    // redaction read of the same tables retried (`unreadable.ts`).
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
    state.failReads = 1;

    const resolved = await slackForWebhook();

    expect(resolved.readable && resolved.slack?.manifest.id).toBe("slack");
  });

  it("is not served when the signing secret is missing, whatever else is set", async () => {
    // Nothing to verify a request with: the route answers 503, as today.
    vi.stubEnv("CHAT_SDK_SLACK_TOKEN", "xoxb-env");
    vi.stubEnv("CHAT_SDK_CHANNEL_ID", "C0ENV");

    const resolved = await slackForWebhook();

    expect(resolved).toEqual({ readable: true, slack: null });
  });

  it("is not served while Slack is disabled, even with the secret", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
    state.connections.set("slack", { ...storedSlack(), enabled: false, source: "environment" });

    expect(await slackForWebhook()).toEqual({ readable: true, slack: null });
  });

  it("leaves a webhook that declares nothing needing the whole connection", async () => {
    // GitLab's webhook goes on to read the merge request, so half a
    // connection must not serve it. Only a declared `webhook.requires` narrows.
    vi.stubEnv("GITLAB_WEBHOOK_SECRET", "hook-secret");

    const resolved = await resolveUsableIntegrations({
      filter: (manifest) => manifest.id === "gitlab",
      forWebhook: { settings: loadSettingsSnapshot },
    });

    expect(resolved.readable && resolved.usable).toEqual([]);
  });
});

/** Slack as the Integrations screen receives it. */
async function slackCard() {
  const card = (await listIntegrations()).integrations.find((integration) => integration.id === "slack");
  if (!card) throw new Error("Slack is not listed");
  return card;
}

describe("the card says what the route does with the command", () => {
  // The admin reads the card to learn whether the command works; the card and
  // the route ask one read (`readWebhookConnection`), and these hold that they
  // give one answer in each of the three states that differ.
  it("says the command is answered while the rest of Slack is not usable", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);

    const card = await slackCard();

    expect(card.state.usable).toBe(false);
    expect(card.webhook).toEqual({
      label: "/ai-workflow slash command",
      requires: ["signingSecret"],
      served: true,
    });
    const resolved = await slackForWebhook();
    expect(resolved.readable && resolved.slack?.manifest.id).toBe("slack");
  });

  it("says the command is refused while Slack is Connected without its signing secret", async () => {
    vi.stubEnv("CHAT_SDK_SLACK_TOKEN", "xoxb-env");
    vi.stubEnv("CHAT_SDK_CHANNEL_ID", "C0ENV");

    const card = await slackCard();

    expect(card.state.usable).toBe(true);
    expect(card.webhook?.served).toBe(false);
    expect(await slackForWebhook()).toEqual({ readable: true, slack: null });
  });

  it("says the command is refused while Slack is switched off", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
    state.connections.set("slack", { ...storedSlack(), enabled: false, source: "environment" });

    expect((await slackCard()).webhook?.served).toBe(false);
    expect(await slackForWebhook()).toEqual({ readable: true, slack: null });
  });
});

describe("who may run it is an operator setting", () => {
  beforeEach(() => {
    vi.stubEnv("CHAT_SDK_SLACK_TOKEN", "xoxb-env");
    vi.stubEnv("CHAT_SDK_CHANNEL_ID", "C0ENV");
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  it("keeps the allowlist in force when the connection's source is switched to stored values", async () => {
    // The admin rotated the bot token by storing new values and switching the
    // source. As a connection field, the allowlist lived in the environment
    // source only, and the switch opened the command to the whole workspace.
    vi.stubEnv("SLACK_ALLOWED_USER_IDS", "U000000001");
    vi.stubEnv("INTEGRATION_SECRETS_KEY", SECRETS_KEY);
    state.connections.set("slack", storedSlack());

    const resolved = await slackForWebhook();

    if (!resolved.readable || !resolved.slack) throw new Error("Slack was not served");
    expect(resolved.slack.ctx.settings).toEqual({ allowedUserIds: ["U000000001"] });
    const reception = await receive(resolved.slack, "cancel AWT-42");
    expect(reception).toMatchObject({
      kind: "answered",
      response: { body: { response_type: "ephemeral", text: "Not authorized." } },
    });
  });

  it("reads the variable exactly as main split it", async () => {
    // main: SLACK_ALLOWED_USER_IDS.split(",").map(trim).filter(Boolean), and an
    // empty list lets everyone in (origin/main integration-settings.ts:96-99).
    const cases: [string | undefined, readonly string[]][] = [
      ["U1, U2,,", ["U1", "U2"]],
      [" , , ", []],
      [undefined, []],
    ];
    for (const [variable, expected] of cases) {
      if (variable === undefined) vi.stubEnv("SLACK_ALLOWED_USER_IDS", undefined);
      else vi.stubEnv("SLACK_ALLOWED_USER_IDS", variable);
      const resolved = await slackForWebhook();
      if (!resolved.readable || !resolved.slack) throw new Error("Slack was not served");
      expect(resolved.slack.ctx.settings, JSON.stringify(variable)).toEqual({ allowedUserIds: expected });
    }
  });

  it("lets a value stored from the dashboard shadow the variable", async () => {
    // Adding a colleague mid-day is a settings change, read by the next command.
    vi.stubEnv("SLACK_ALLOWED_USER_IDS", "U000000001");
    state.settingsRows = [{ key: "SLACK_ALLOWED_USER_IDS", value: ["U000000001", CALLER] }];

    const resolved = await slackForWebhook();

    if (!resolved.readable || !resolved.slack) throw new Error("Slack was not served");
    expect((await receive(resolved.slack, "cancel AWT-42")).kind).toBe("run_control");
  });

  it("refuses to serve the command when the settings cannot be read, rather than opening it", async () => {
    // An allowlist nobody could read is not an empty one; empty means everyone.
    const resolved = await slackForWebhook(async () => {
      throw new Error("the settings read timed out");
    });

    expect(resolved).toEqual({ readable: false, reason: "the settings read timed out" });
  });



});
