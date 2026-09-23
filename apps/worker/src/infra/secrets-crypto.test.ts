import { describe, expect, it } from "vitest";

import {
  IntegrationSecretCorruptedError,
  IntegrationSecretForeignScopeError,
  IntegrationSecretKeyMismatchError,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  integrationSecretsKeyId,
  isValidIntegrationSecretsKey,
  looksLikeIntegrationSecret,
  readIntegrationSecretEnvelope,
} from "./secrets-crypto.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("integration secret envelope", () => {
  it("round-trips a value under the slot it was written for", () => {
    const envelope = encryptIntegrationSecret("s3cr3t-token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    expect(
      decryptIntegrationSecret(envelope, KEY_A, {
        integrationId: "jira",
        fieldKey: "apiToken",
      }),
    ).toBe("s3cr3t-token");
  });

  it("never puts the plaintext in the envelope", () => {
    const envelope = encryptIntegrationSecret("s3cr3t-token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    expect(envelope).not.toContain("s3cr3t-token");
    expect(envelope.startsWith("v1:")).toBe(true);
  });

  it("reports a foreign key by its id rather than as damage", () => {
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    expect(() =>
      decryptIntegrationSecret(envelope, KEY_B, {
        integrationId: "jira",
        fieldKey: "apiToken",
      }),
    ).toThrow(IntegrationSecretKeyMismatchError);
  });

  it("reports a ciphertext from another integration as the wrong slot", () => {
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    expect(() =>
      decryptIntegrationSecret(envelope, KEY_A, {
        integrationId: "slack",
        fieldKey: "apiToken",
      }),
    ).toThrow(IntegrationSecretForeignScopeError);
  });

  it("reports a ciphertext from another field of the same integration as the wrong slot", () => {
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    expect(() =>
      decryptIntegrationSecret(envelope, KEY_A, {
        integrationId: "jira",
        fieldKey: "webhookSecret",
      }),
    ).toThrow(IntegrationSecretForeignScopeError);
  });

  it("reports an altered body as damage, not as a wrong key or a wrong slot", () => {
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    const parts = envelope.split(":");
    const body = Buffer.from(parts[5] ?? "", "base64");
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[5] = body.toString("base64");
    expect(() =>
      decryptIntegrationSecret(parts.join(":"), KEY_A, {
        integrationId: "jira",
        fieldKey: "apiToken",
      }),
    ).toThrow(IntegrationSecretCorruptedError);
  });

  it("reads the key id and the slot of a stored envelope without the key", () => {
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    expect(readIntegrationSecretEnvelope(envelope)).toEqual({
      keyId: integrationSecretsKeyId(KEY_A),
      scope: "jira.apiToken",
    });
  });

  it("refuses a key that is not 32 bytes of hex", () => {
    expect(isValidIntegrationSecretsKey(KEY_A)).toBe(true);
    expect(isValidIntegrationSecretsKey("abc")).toBe(false);
    expect(isValidIntegrationSecretsKey(`${KEY_A}00`)).toBe(false);
  });

  it("recognises its own envelope anywhere in a string, so leak tests can look for one", () => {
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    expect(looksLikeIntegrationSecret(`stored ${envelope} here`)).toBe(true);
    expect(looksLikeIntegrationSecret("v1:not-an-envelope")).toBe(false);
  });

  it("refuses a ciphertext whose slot was rewritten in the database", () => {
    // The slot is stored in the clear so a read can explain itself, which means
    // anyone with database access can edit it. It is also the GCM additional
    // data, so the edit breaks the tag: without that binding this decrypt would
    // happily hand back another integration's credential.
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    const parts = envelope.split(":");
    parts[2] = "slack.apiToken";
    expect(() =>
      decryptIntegrationSecret(parts.join(":"), KEY_A, {
        integrationId: "slack",
        fieldKey: "apiToken",
      }),
    ).toThrow(IntegrationSecretCorruptedError);
  });

  it("refuses a ciphertext whose field was rewritten within one integration", () => {
    const envelope = encryptIntegrationSecret("token", KEY_A, {
      integrationId: "jira",
      fieldKey: "apiToken",
    });
    const parts = envelope.split(":");
    parts[2] = "jira.webhookSecret";
    expect(() =>
      decryptIntegrationSecret(parts.join(":"), KEY_A, {
        integrationId: "jira",
        fieldKey: "webhookSecret",
      }),
    ).toThrow(IntegrationSecretCorruptedError);
  });

  it("never encrypts the same value the same way twice", () => {
    // A fixed IV passes every other test in this file and destroys AES-GCM: two
    // messages under one IV and key leak the keystream. This is the only test
    // that can see it.
    const scope = { integrationId: "jira", fieldKey: "apiToken" };
    const first = encryptIntegrationSecret("token", KEY_A, scope);
    const second = encryptIntegrationSecret("token", KEY_A, scope);
    expect(first).not.toBe(second);
    expect(first.split(":")[3]).not.toBe(second.split(":")[3]);
    expect(decryptIntegrationSecret(second, KEY_A, scope)).toBe("token");
  });

  it("reads a string that is not an envelope as damage rather than crashing", () => {
    const scope = { integrationId: "jira", fieldKey: "apiToken" };
    const envelope = encryptIntegrationSecret("token", KEY_A, scope);
    const parts = envelope.split(":");
    // Nothing here is one of ours at all, so a read cannot even say which key
    // wrote it: the header has to come back null rather than half-parsed.
    const notAnEnvelope: Record<string, string> = {
      "too few parts": parts.slice(0, 4).join(":"),
      "a version this build does not know": ["v2", ...parts.slice(1)].join(":"),
      "a key id that is not a key id": [parts[0], "zzzz", ...parts.slice(2)].join(":"),
      "nothing at all": "",
    };
    for (const [name, ciphertext] of Object.entries(notAnEnvelope)) {
      expect(readIntegrationSecretEnvelope(ciphertext), name).toBeNull();
      expect(
        () => decryptIntegrationSecret(ciphertext, KEY_A, scope),
        name,
      ).toThrow(IntegrationSecretCorruptedError);
    }

    // A readable header over a body that cannot be one: the read still says
    // which key and slot it claims, which is what a card needs, and the decrypt
    // still refuses.
    const brokenBody = [
      ...parts.slice(0, 3),
      Buffer.from("short").toString("base64"),
      ...parts.slice(4),
    ].join(":");
    expect(readIntegrationSecretEnvelope(brokenBody)).toEqual({
      keyId: integrationSecretsKeyId(KEY_A),
      scope: "jira.apiToken",
    });
    expect(() => decryptIntegrationSecret(brokenBody, KEY_A, scope)).toThrow(
      IntegrationSecretCorruptedError,
    );
  });

  it("gives two different key ids to two different keys", () => {
    expect(integrationSecretsKeyId(KEY_A)).not.toBe(integrationSecretsKeyId(KEY_B));
    expect(integrationSecretsKeyId(KEY_A)).toMatch(/^[0-9a-f]{8}$/);
  });
});
