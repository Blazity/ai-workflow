import { defineIntegration } from "@integrations/sdk";
import { describe, expect, it } from "vitest";

import { encryptIntegrationSecret, integrationSecretsKeyId } from "../../infra/secrets-crypto.js";
import { readConnectionValues, redactIntegrationText } from "./connection-values.js";
import { environmentReaderFrom } from "./resolve.js";

const manifest = defineIntegration({
  id: "fixture",
  name: "Fixture",
  description: "A provider core has never heard of.",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", env: "FIXTURE_BASE_URL", secret: false, format: "url" },
      { key: "apiToken", label: "API token", env: "FIXTURE_API_TOKEN", secret: true },
      { key: "appId", label: "App id", env: "FIXTURE_APP_ID", secret: false, format: "integer" },
      {
        key: "host",
        label: "Host",
        env: "FIXTURE_HOST",
        secret: false,
        optional: true,
        default: "https://fixture.example",
      },
    ],
  },
  capabilities: [],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "The token is accepted.", critical: true }],
});

const KEY = "a".repeat(64);
const KEY_ID = integrationSecretsKeyId(KEY);
const SECRETS_KEY = { present: true, keyId: KEY_ID, key: KEY } as const;

describe("the values an integration actually receives", () => {
  it("reads the environment, applying a default the source leaves unset", () => {
    const result = readConnectionValues({
      manifest,
      source: "environment",
      environment: environmentReaderFrom({
        FIXTURE_BASE_URL: "https://fixture.example/site",
        FIXTURE_API_TOKEN: "token-abcdef",
        FIXTURE_APP_ID: "42",
      }),
      active: null,
      secretsKey: SECRETS_KEY,
    });
    expect(result).toEqual({
      ok: true,
      values: {
        baseUrl: "https://fixture.example/site",
        apiToken: "token-abcdef",
        appId: 42,
        host: "https://fixture.example",
      },
    });
  });

  it("takes the whitespace off a pasted value rather than handing it to the provider", () => {
    const result = readConnectionValues({
      manifest,
      source: "environment",
      environment: environmentReaderFrom({
        FIXTURE_BASE_URL: " https://fixture.example/site ",
        FIXTURE_API_TOKEN: "token-abcdef\n",
        FIXTURE_APP_ID: "42",
      }),
      active: null,
      secretsKey: SECRETS_KEY,
    });
    expect(result.ok && result.values.apiToken).toBe("token-abcdef");
    expect(result.ok && result.values.baseUrl).toBe("https://fixture.example/site");
  });

  it("decrypts a stored secret for its own slot", () => {
    const result = readConnectionValues({
      manifest,
      source: "stored",
      environment: environmentReaderFrom({}),
      active: {
        version: 1,
        config: { baseUrl: "https://fixture.example/stored", appId: "7" },
        secrets: {
          apiToken: encryptIntegrationSecret("stored-token", KEY, {
            integrationId: "fixture",
            fieldKey: "apiToken",
          }),
        },
        testStatus: "passed",
        testReason: null,
        testMessage: null,
        testedAt: "2026-09-18T10:00:00.000Z",
        createdAt: "2026-09-18T10:00:00.000Z",
      },
      secretsKey: SECRETS_KEY,
    });
    expect(result.ok && result.values.apiToken).toBe("stored-token");
    expect(result.ok && result.values.appId).toBe(7);
  });

  it("refuses with the reason an admin can act on when the key cannot open the value", () => {
    const result = readConnectionValues({
      manifest,
      source: "stored",
      environment: environmentReaderFrom({}),
      active: {
        version: 1,
        config: { baseUrl: "https://fixture.example/stored", appId: "7" },
        secrets: {
          apiToken: encryptIntegrationSecret("stored-token", "b".repeat(64), {
            integrationId: "fixture",
            fieldKey: "apiToken",
          }),
        },
        testStatus: "passed",
        testReason: null,
        testMessage: null,
        testedAt: null,
        createdAt: "2026-09-18T10:00:00.000Z",
      },
      secretsKey: SECRETS_KEY,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toBe("secrets_key_mismatch");
  });

  it("refuses when the deployment has no key at all", () => {
    const result = readConnectionValues({
      manifest,
      source: "stored",
      environment: environmentReaderFrom({}),
      active: {
        version: 1,
        config: { baseUrl: "https://fixture.example/stored", appId: "7" },
        secrets: { apiToken: "v1:deadbeef:fixture.apiToken:a:b:c" },
        testStatus: "passed",
        testReason: null,
        testMessage: null,
        testedAt: null,
        createdAt: "2026-09-18T10:00:00.000Z",
      },
      secretsKey: { present: false },
    });
    expect(!result.ok && result.failure.reason).toBe("secrets_key_missing");
  });
});

describe("what a provider's own words may carry back", () => {
  it("takes the credential out of a message that echoed it (INT-023)", () => {
    const message = redactIntegrationText(
      'Bearer ghp_abcdef1234567890 was rejected: {"token":"ghp_abcdef1234567890"}',
      ["ghp_abcdef1234567890"],
    );
    expect(message).not.toContain("ghp_abcdef1234567890");
    expect(message).toContain("was rejected");
  });

  it("leaves a message that carries no credential exactly as the provider wrote it", () => {
    expect(redactIntegrationText("401 Unauthorized", ["ghp_abcdef1234567890"])).toBe(
      "401 Unauthorized",
    );
  });

  it("removes a short credential too, because short does not mean public", () => {
    // A four-character token is a bad token, not a public one. Leaving it in
    // the card, the stored message and the log because it was short is exactly
    // the leak this exists to prevent, and a mangled sentence is the cheaper
    // mistake of the two.
    expect(redactIntegrationText("rejected key ab12", ["ab12"])).toBe("rejected key [redacted]");
  });

  it("catches a credential the provider encoded before echoing it", () => {
    const token = "ghp_abcdef1234567890";
    const encoded = Buffer.from(token, "utf8").toString("base64");
    const message = redactIntegrationText(`rejected: ${encoded}`, [token]);
    expect(message).not.toContain(encoded);
  });

  it("catches a credential echoed inside a URL", () => {
    const token = "ghp_abc+def/12345678";
    const message = redactIntegrationText(
      `GET /x?token=${encodeURIComponent(token)} failed`,
      [token],
    );
    expect(message).not.toContain(encodeURIComponent(token));
  });
});
