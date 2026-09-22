import { defineIntegration } from "@integrations/sdk";
import { describe, expect, it } from "vitest";

import { encryptIntegrationSecret, integrationSecretsKeyId } from "../../infra/secrets-crypto.js";
import {
  type StoredIntegrationConnection,
  type StoredIntegrationVersion,
  checkIntegrationPin,
  environmentReaderFrom,
  integrationSecretDigest,
  integrationVerificationFingerprint,
  resolveIntegrationState,
} from "./resolve.js";

/**
 * Expected values here come from the plan's decision 9 and the scenario
 * catalogue (`docs/qa/integrations-scenarios.md`), never from running the
 * resolver. The fixture is shaped like the providers the later stages move over:
 * a site URL that identifies WHICH account, a token that proves WHO, an optional
 * field, and a field with a default.
 */
const manifest = defineIntegration({
  id: "fixture",
  name: "Fixture",
  description: "A provider core has never heard of.",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", env: "FIXTURE_BASE_URL", secret: false, format: "url" },
      { key: "apiToken", label: "API token", env: "FIXTURE_API_TOKEN", secret: true },
      { key: "botLogin", label: "Bot login", env: "FIXTURE_BOT_LOGIN", secret: false, optional: true },
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
const OTHER_KEY = "b".repeat(64);
const KEY_ID = integrationSecretsKeyId(KEY);
const PRESENT = { present: true, keyId: KEY_ID } as const;
const ABSENT = { present: false } as const;

const COMPLETE_ENV = {
  FIXTURE_BASE_URL: "https://fixture.example/site",
  FIXTURE_API_TOKEN: "env-token",
};

function resolve(input: {
  env?: Record<string, string>;
  stored?: StoredIntegrationConnection | null;
  key?: typeof PRESENT | typeof ABSENT;
}) {
  return resolveIntegrationState({
    manifest,
    environment: environmentReaderFrom(input.env ?? {}),
    stored: input.stored ?? null,
    secretsKey: input.key ?? PRESENT,
  });
}

function version(overrides: Partial<StoredIntegrationVersion> = {}): StoredIntegrationVersion {
  return {
    version: 1,
    config: { baseUrl: "https://fixture.example/stored" },
    secrets: { apiToken: encryptIntegrationSecret("stored-token", KEY, {
      integrationId: "fixture",
      fieldKey: "apiToken",
    }) },
    secretDigests: { apiToken: integrationSecretDigest("fixture", "apiToken", "stored-token") },
    testStatus: "passed",
    testReason: null,
    testMessage: null,
    testedAt: "2026-09-18T10:00:00.000Z",
    createdAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function storedRow(overrides: Partial<StoredIntegrationConnection> = {}): StoredIntegrationConnection {
  const active = overrides.active === undefined ? version() : overrides.active;
  return {
    enabled: true,
    source: "stored",
    latestVersion: active?.version ?? 0,
    activeVersion: active?.version ?? null,
    active,
    latest: null,
    lastTest: null,
    ...overrides,
  };
}

/** The fingerprint a verdict recorded against these exact values would carry. */
function verificationFingerprintOf(env: Record<string, string>): string {
  return integrationVerificationFingerprint({
    manifest,
    environment: environmentReaderFrom(env),
    source: "environment",
    active: null,
  });
}

describe("the environment as the source", () => {
  it("is Connected when every required variable is set, and asks nobody to act (INT-002)", () => {
    const state = resolve({ env: COMPLETE_ENV });
    expect(state.status).toBe("connected");
    expect(state.source).toBe("environment");
    expect(state.usable).toBe(true);
    expect(state.failure).toBeNull();
  });

  it("says nothing was ever verified rather than inventing a time", () => {
    expect(resolve({ env: COMPLETE_ENV }).verification).toEqual({ state: "never_tested" });
  });

  it("is Failing and names the missing variables when only some are set (INT-019)", () => {
    const state = resolve({ env: { FIXTURE_BASE_URL: "https://fixture.example/site" } });
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("environment_incomplete");
    expect(state.failure?.missingVariables).toEqual(["FIXTURE_API_TOKEN"]);
    expect(state.usable).toBe(false);
  });

  it("is Not connected when the deployment sets none of its variables", () => {
    const state = resolve({ env: {} });
    expect(state.status).toBe("not_connected");
    expect(state.failure).toBeNull();
  });

  it("does not count an optional variable or one with a default as missing", () => {
    const state = resolve({ env: COMPLETE_ENV });
    expect(state.environment.complete).toBe(true);
    expect(state.environment.missingVariables).toEqual([]);
  });

  it("treats a variable set to whitespace as unset", () => {
    const state = resolve({ env: { ...COMPLETE_ENV, FIXTURE_API_TOKEN: "   " } });
    expect(state.failure?.missingVariables).toEqual(["FIXTURE_API_TOKEN"]);
  });

  it("reports exactly the variables this deployment sets", () => {
    const state = resolve({ env: { ...COMPLETE_ENV, FIXTURE_BOT_LOGIN: "bot" } });
    expect(state.environment.setVariables).toEqual([
      "FIXTURE_BASE_URL",
      "FIXTURE_API_TOKEN",
      "FIXTURE_BOT_LOGIN",
    ]);
  });
});

describe("stored values as the source", () => {
  it("is Connected when the active version is complete and its test passed", () => {
    const state = resolve({ stored: storedRow() });
    expect(state.status).toBe("connected");
    expect(state.source).toBe("stored");
    expect(state.verification).toEqual({
      state: "passed",
      at: "2026-09-18T10:00:00.000Z",
    });
  });

  it("is Failing when the active version is in use without a passing test", () => {
    const state = resolve({
      stored: storedRow({
        active: version({
          testStatus: "failed",
          testReason: "credential_rejected",
          testMessage: "401 Unauthorized",
        }),
      }),
    });
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("credential_rejected");
    expect(state.failure?.message).toBe("401 Unauthorized");
  });

  it("is Failing when a required field was never stored", () => {
    const state = resolve({
      stored: storedRow({ active: version({ secrets: {} }) }),
    });
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("stored_incomplete");
    expect(state.failure?.missingFields).toEqual(["apiToken"]);
  });

  it("is Not connected when the source is stored but nothing was ever activated", () => {
    const state = resolve({
      stored: storedRow({ active: null, activeVersion: null, latestVersion: 0 }),
    });
    expect(state.status).toBe("not_connected");
  });
});

describe("a value in use that cannot be what its field is", () => {
  it("fails an environment connection and names the variable, never the value", () => {
    const state = resolve({ env: { ...COMPLETE_ENV, FIXTURE_API_TOKEN: "env-to\nken-77c1" } });
    expect(state.status).toBe("failing");
    expect(state.usable).toBe(false);
    expect(state.failure).toEqual({
      reason: "value_malformed",
      message:
        "The API token has a line break in it, which no request can carry. Set FIXTURE_API_TOKEN again on this deployment.",
    });
    expect(JSON.stringify(state)).not.toContain("77c1");
  });

  it("fails stored values saved before the address was checked, asking for it again", () => {
    const state = resolve({
      stored: storedRow({ active: version({ config: { baseUrl: "fixture.example/stored" } }) }),
    });
    expect(state.status).toBe("failing");
    expect(state.failure).toEqual({
      reason: "value_malformed",
      message:
        "The Site URL is not a web address a request can go to; it has to start with https://. Enter it again.",
    });
  });

  it("names what is missing first, since a value that is not there cannot be malformed", () => {
    const state = resolve({ env: { FIXTURE_BASE_URL: "fixture.example" } });
    expect(state.failure?.reason).toBe("environment_incomplete");
  });
});

describe("stored values prepared while the environment is still the source (INT-053)", () => {
  it("leaves the status to the environment and reports the stored values as ready", () => {
    const state = resolve({
      env: COMPLETE_ENV,
      stored: storedRow({ source: "environment" }),
    });
    expect(state.source).toBe("environment");
    expect(state.status).toBe("connected");
    expect(state.stored.activeVersion).toBe(1);
    expect(state.stored.complete).toBe(true);
  });

  it("reports a save that failed its test without touching the live status (INT-051, INT-018)", () => {
    const failed = version({
      version: 2,
      testStatus: "failed",
      testReason: "credential_rejected",
      testMessage: "401 Unauthorized",
      testedAt: "2026-09-18T11:00:00.000Z",
    });
    const state = resolve({
      env: COMPLETE_ENV,
      stored: storedRow({ source: "environment", latestVersion: 2, latest: failed }),
    });
    expect(state.status).toBe("connected");
    expect(state.stored.prepared).toEqual({
      version: 2,
      at: "2026-09-18T11:00:00.000Z",
      failure: { reason: "credential_rejected", message: "401 Unauthorized" },
    });
  });
});

describe("the disable switch (INT-043)", () => {
  it("shows Disabled over an environment connection and keeps the connection underneath", () => {
    const state = resolve({ env: COMPLETE_ENV, stored: storedRow({ enabled: false, source: "environment", active: null, activeVersion: null, latestVersion: 0 }) });
    expect(state.status).toBe("disabled");
    expect(state.connection).toBe("connected");
    expect(state.usable).toBe(false);
  });

  it("shows Disabled over stored values and keeps them for re-enabling (INT-046)", () => {
    const state = resolve({ stored: storedRow({ enabled: false }) });
    expect(state.status).toBe("disabled");
    expect(state.connection).toBe("connected");
    expect(state.stored.activeVersion).toBe(1);
  });
});

describe("the secrets key", () => {
  it("disables stored secrets and says so when the key is absent (INT-014)", () => {
    const state = resolve({ stored: storedRow(), key: ABSENT });
    expect(state.secretsKeyAvailable).toBe(false);
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("secrets_key_missing");
  });

  it("leaves an environment-configured integration untouched without the key (INT-014)", () => {
    const state = resolve({ env: COMPLETE_ENV, key: ABSENT });
    expect(state.status).toBe("connected");
    expect(state.secretsKeyAvailable).toBe(false);
  });

  it("reads a value stored under another key as Failing, asking for it again (INT-057)", () => {
    const state = resolve({
      stored: storedRow({
        active: version({
          secrets: {
            apiToken: encryptIntegrationSecret("stored-token", OTHER_KEY, {
              integrationId: "fixture",
              fieldKey: "apiToken",
            }),
          },
        }),
      }),
    });
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("secrets_key_mismatch");
    expect(state.failure?.message).toContain("enter it again");
  });

  it("reads a ciphertext from another integration as the wrong slot, not a bad credential", () => {
    const state = resolve({
      stored: storedRow({
        active: version({
          secrets: {
            apiToken: encryptIntegrationSecret("stored-token", KEY, {
              integrationId: "other",
              fieldKey: "apiToken",
            }),
          },
        }),
      }),
    });
    expect(state.failure?.reason).toBe("secret_foreign");
  });
});

describe("a provider that could not be reached", () => {
  const unreachable = (fingerprint: string) =>
    resolve({
      env: COMPLETE_ENV,
      stored: storedRow({
        source: "environment",
        active: null,
        activeVersion: null,
        latestVersion: 0,
        lastTest: {
          status: "failed",
          reason: "provider_unreachable",
          message: "fetch failed",
          at: "2026-09-18T12:00:00.000Z",
          fingerprint,
        },
      }),
    });

  it("leaves the connection exactly as it was, because it says nothing about the values", () => {
    // Without this, thirty seconds of provider downtime while an admin happens
    // to press Test would stop every run until a human pressed Test again, and
    // there is no "save it anyway" to climb back out with.
    const state = unreachable(verificationFingerprintOf(COMPLETE_ENV));
    expect(state.status).toBe("connected");
    expect(state.usable).toBe(true);
    expect(state.failure).toBeNull();
  });

  it("still says what happened and when, so nobody thinks the check ran", () => {
    const state = unreachable(verificationFingerprintOf(COMPLETE_ENV));
    expect(state.verification).toEqual({
      state: "failed",
      at: "2026-09-18T12:00:00.000Z",
      failure: { reason: "provider_unreachable", message: "fetch failed" },
    });
  });

  it("is not how a refused credential behaves", () => {
    const refused = resolve({
      env: COMPLETE_ENV,
      stored: storedRow({
        source: "environment",
        active: null,
        activeVersion: null,
        latestVersion: 0,
        lastTest: {
          status: "failed",
          reason: "credential_rejected",
          message: "401 Unauthorized",
          at: "2026-09-18T12:00:00.000Z",
          fingerprint: verificationFingerprintOf(COMPLETE_ENV),
        },
      }),
    });
    expect(refused.status).toBe("failing");
    expect(refused.usable).toBe(false);
  });
});

describe("a test verdict and the values it was about", () => {
  it("demotes an otherwise complete environment when the last test failed against these values", () => {
    const state = resolve({
      env: COMPLETE_ENV,
      stored: storedRow({
        source: "environment",
        active: null,
        activeVersion: null,
        latestVersion: 0,
        lastTest: {
          status: "failed",
          reason: "credential_rejected",
          message: "401 Unauthorized",
          at: "2026-09-18T12:00:00.000Z",
          fingerprint: verificationFingerprintOf(COMPLETE_ENV),
        },
      }),
    });
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("credential_rejected");
  });

  it("forgets a verdict about values that have since changed, rather than blaming the new ones", () => {
    const state = resolve({
      env: { ...COMPLETE_ENV, FIXTURE_API_TOKEN: "rotated-token" },
      stored: storedRow({
        source: "environment",
        active: null,
        activeVersion: null,
        latestVersion: 0,
        lastTest: {
          status: "failed",
          reason: "credential_rejected",
          message: "401 Unauthorized",
          at: "2026-09-18T12:00:00.000Z",
          fingerprint: "0000deadbeef",
        },
      }),
    });
    expect(state.status).toBe("connected");
    expect(state.verification).toEqual({ state: "stale", at: "2026-09-18T12:00:00.000Z" });
  });
});

describe("what a run pins, and what counts as a change", () => {
  const base = resolve({ env: COMPLETE_ENV }).pin.configFingerprint;

  it("gives byte-identical values the same fingerprint, so re-saving strands nobody", () => {
    expect(resolve({ env: COMPLETE_ENV }).pin.configFingerprint).toBe(base);
  });

  it("follows a rotated secret: the fingerprint does not move", () => {
    const rotated = resolve({
      env: { ...COMPLETE_ENV, FIXTURE_API_TOKEN: "rotated-token" },
    });
    expect(rotated.pin.configFingerprint).toBe(base);
  });

  it("treats a changed site as a reconfiguration", () => {
    const moved = resolve({
      env: { ...COMPLETE_ENV, FIXTURE_BASE_URL: "https://fixture.example/other" },
    });
    expect(moved.pin.configFingerprint).not.toBe(base);
  });

  it("treats a secret and a non-secret changed together as a reconfiguration", () => {
    const both = resolve({
      env: { FIXTURE_BASE_URL: "https://fixture.example/other", FIXTURE_API_TOKEN: "rotated" },
    });
    expect(both.pin.configFingerprint).not.toBe(base);
  });

  it("does not call a source switch with identical values a reconfiguration", () => {
    const stored = resolve({
      stored: storedRow({
        active: version({ config: { baseUrl: COMPLETE_ENV.FIXTURE_BASE_URL } }),
      }),
    });
    expect(stored.pin.configFingerprint).toBe(base);
  });

  it("does not call the enable switch a reconfiguration", () => {
    const disabled = resolve({
      env: COMPLETE_ENV,
      stored: storedRow({
        enabled: false,
        source: "environment",
        active: null,
        activeVersion: null,
        latestVersion: 0,
      }),
    });
    expect(disabled.pin.configFingerprint).toBe(base);
  });

  it("counts an optional field appearing as a reconfiguration", () => {
    const withLogin = resolve({ env: { ...COMPLETE_ENV, FIXTURE_BOT_LOGIN: "bot" } });
    expect(withLogin.pin.configFingerprint).not.toBe(base);
  });

  it("ignores a field this deployment leaves empty, so a manifest can grow", () => {
    // S8 to S12 each rewrite a manifest. If an added field with no value here
    // moved the fingerprint, every run in flight would stop with `reconfigured`
    // for a connection nobody touched. A field this deployment actually sets
    // still moves it, which the test above shows.
    const grown = defineIntegration({
      ...manifest,
      connection: {
        fields: [
          ...manifest.connection.fields,
          { key: "region", label: "Region", env: "FIXTURE_REGION", secret: false, optional: true },
        ],
      },
    });
    const after = resolveIntegrationState({
      manifest: grown,
      environment: environmentReaderFrom(COMPLETE_ENV),
      stored: null,
      secretsKey: PRESENT,
    });
    expect(after.pin.configFingerprint).toBe(base);
  });
});

describe("an integration whose only identifying value is a secret", () => {
  /**
   * Slack's bot token names a workspace as much as it authenticates. Without the
   * manifest saying so, every field of such an integration is a secret, the
   * configuration fingerprint is constant, and swapping the token for another
   * workspace's reads as a rotation: a run in flight would follow it and post
   * into the wrong company's channels.
   */
  const workspaceToken = defineIntegration({
    id: "onlysecret",
    name: "Only secret",
    description: "A provider that identifies the account by the token alone.",
    connection: {
      fields: [
        { key: "botToken", label: "Bot token", env: "ONLYSECRET_BOT_TOKEN", secret: true, identity: true },
        { key: "signingSecret", label: "Signing secret", env: "ONLYSECRET_SIGNING", secret: true },
      ],
    },
    capabilities: [],
    blocks: [],
    pages: [],
    health: [{ id: "auth", label: "Auth", description: "The token is accepted.", critical: true }],
  });

  const pinFor = (env: Record<string, string>) =>
    resolveIntegrationState({
      manifest: workspaceToken,
      environment: environmentReaderFrom(env),
      stored: null,
      secretsKey: PRESENT,
    }).pin.configFingerprint;

  const original = {
    ONLYSECRET_BOT_TOKEN: "xoxb-workspace-one",
    ONLYSECRET_SIGNING: "signing-one",
  };

  it("stops a run when the marked secret is swapped for another account's", () => {
    expect(pinFor({ ...original, ONLYSECRET_BOT_TOKEN: "xoxb-workspace-two" })).not.toBe(
      pinFor(original),
    );
  });

  it("still follows a rotation of a secret that only authenticates", () => {
    expect(pinFor({ ...original, ONLYSECRET_SIGNING: "signing-two" })).toBe(pinFor(original));
  });

  it("does not move the pin when the same token is stored again", () => {
    // The journey this exists for: an admin re-pastes the same bot token, or
    // saves it again while fixing a URL. AES-GCM gives a new initialisation
    // vector every time, so the stored bytes differ although the account did
    // not. A pin built from those bytes would stop every run in flight.
    const pinForStored = (plaintext: string) =>
      resolveIntegrationState({
        manifest: workspaceToken,
        environment: environmentReaderFrom({}),
        stored: {
          enabled: true,
          source: "stored",
          latestVersion: 1,
          activeVersion: 1,
          active: {
            version: 1,
            config: {},
            secrets: {
              botToken: encryptIntegrationSecret(plaintext, KEY, {
                integrationId: "onlysecret",
                fieldKey: "botToken",
              }),
              signingSecret: encryptIntegrationSecret("signing-one", KEY, {
                integrationId: "onlysecret",
                fieldKey: "signingSecret",
              }),
            },
            secretDigests: {
              botToken: integrationSecretDigest("onlysecret", "botToken", plaintext),
              signingSecret: integrationSecretDigest("onlysecret", "signingSecret", "signing-one"),
            },
            testStatus: "passed",
            testReason: null,
            testMessage: null,
            testedAt: "2026-09-18T10:00:00.000Z",
            createdAt: "2026-09-18T10:00:00.000Z",
          },
          latest: null,
          lastTest: null,
        },
        secretsKey: PRESENT,
      }).pin.configFingerprint;

    // Two encryptions of the same value, which differ byte for byte.
    expect(pinForStored("xoxb-one")).toBe(pinForStored("xoxb-one"));
    // And a genuinely different account still moves it.
    expect(pinForStored("xoxb-two")).not.toBe(pinForStored("xoxb-one"));
  });

  it("gives the same pin whether the token arrives from the environment or from storage", () => {
    // Switching source with the same values is not a reconfiguration, and that
    // has to hold for a secret the manifest marks as naming the account too.
    const fromEnvironment = resolveIntegrationState({
      manifest: workspaceToken,
      environment: environmentReaderFrom(original),
      stored: null,
      secretsKey: PRESENT,
    }).pin.configFingerprint;

    const fromStorage = resolveIntegrationState({
      manifest: workspaceToken,
      environment: environmentReaderFrom({}),
      stored: {
        enabled: true,
        source: "stored",
        latestVersion: 1,
        activeVersion: 1,
        active: {
          version: 1,
          config: {},
          secrets: { botToken: "irrelevant", signingSecret: "irrelevant" },
          secretDigests: {
            botToken: integrationSecretDigest("onlysecret", "botToken", original.ONLYSECRET_BOT_TOKEN),
            signingSecret: integrationSecretDigest(
              "onlysecret",
              "signingSecret",
              original.ONLYSECRET_SIGNING,
            ),
          },
          testStatus: "passed",
          testReason: null,
          testMessage: null,
          testedAt: "2026-09-18T10:00:00.000Z",
          createdAt: "2026-09-18T10:00:00.000Z",
        },
        latest: null,
        lastTest: null,
      },
      secretsKey: PRESENT,
    }).pin.configFingerprint;

    expect(fromStorage).toBe(fromEnvironment);
  });

  it("puts no secret value into what it pins", () => {
    const state = resolveIntegrationState({
      manifest: workspaceToken,
      environment: environmentReaderFrom(original),
      stored: null,
      secretsKey: PRESENT,
    });
    expect(JSON.stringify(state)).not.toContain("xoxb-workspace-one");
    expect(state.pin.configFingerprint).not.toContain("xoxb");
  });
});

describe("a run checking the connection it pinned", () => {
  const connected = resolve({ env: COMPLETE_ENV });

  it("lets a run continue against the configuration it started with", () => {
    expect(checkIntegrationPin(connected.pin, connected)).toEqual({ ok: true });
  });

  it("fails a run whose integration was disabled, live", () => {
    const disabled = resolve({
      env: COMPLETE_ENV,
      stored: storedRow({ enabled: false, source: "environment", active: null, activeVersion: null, latestVersion: 0 }),
    });
    expect(checkIntegrationPin(connected.pin, disabled)).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("fails a run whose integration was disconnected", () => {
    const gone = resolve({ env: {} });
    expect(checkIntegrationPin(connected.pin, gone)).toEqual({
      ok: false,
      reason: "disconnected",
    });
  });

  it("fails a run whose configuration moved under it", () => {
    const moved = resolve({
      env: { ...COMPLETE_ENV, FIXTURE_BASE_URL: "https://fixture.example/other" },
    });
    expect(checkIntegrationPin(connected.pin, moved)).toEqual({
      ok: false,
      reason: "reconfigured",
    });
  });

  it("says disabled rather than reconfigured when both are true", () => {
    const both = resolve({
      env: { ...COMPLETE_ENV, FIXTURE_BASE_URL: "https://fixture.example/other" },
      stored: storedRow({ enabled: false, source: "environment", active: null, activeVersion: null, latestVersion: 0 }),
    });
    expect(checkIntegrationPin(connected.pin, both)).toEqual({ ok: false, reason: "disabled" });
  });

  it("says disconnected rather than reconfigured when both are true", () => {
    const both = resolve({ env: { FIXTURE_BASE_URL: "https://fixture.example/other" } });
    const check = checkIntegrationPin(connected.pin, both);
    expect(check).toMatchObject({ ok: false, reason: "disconnected" });
  });

  it("carries the reason the run view needs, not only the three run-facing words", () => {
    // `disconnected` covers a missing variable, a refused credential and an
    // unreadable secret, and an operator reading a failed run needs to know
    // which of the three they are in.
    const partial = resolve({ env: { FIXTURE_BASE_URL: "https://fixture.example/site" } });
    const check = checkIntegrationPin(connected.pin, partial);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.failure?.reason).toBe("environment_incomplete");
    expect(check.ok === false && check.failure?.missingVariables).toEqual(["FIXTURE_API_TOKEN"]);
  });

  it("refuses a pin that belongs to another integration instead of answering about this one", () => {
    const foreign = { integrationId: "other", configFingerprint: connected.pin.configFingerprint };
    const check = checkIntegrationPin(foreign, connected);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.failure?.message).toContain("other");
  });
});

describe("what the resolver hands to anyone who asks", () => {
  it("carries no secret value and no ciphertext, under either source", () => {
    const serialized = JSON.stringify([
      resolve({ env: { ...COMPLETE_ENV, FIXTURE_API_TOKEN: "env-token-abcdef" } }),
      resolve({ stored: storedRow() }),
    ]);
    expect(serialized).not.toContain("env-token-abcdef");
    expect(serialized).not.toContain("stored-token");
    expect(serialized).not.toContain(`v1:${KEY_ID}`);
  });
});
